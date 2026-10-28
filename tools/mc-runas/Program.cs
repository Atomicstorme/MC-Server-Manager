// mc-runas: starts a server as the limited "mcserver" Windows account and
// relays its console, so the manager can drive it like a normal child.
//
//   mc-runas.exe <credFile> <workDir> -- <exe> [args...]
//
// credFile holds "user\npassword", DPAPI-encrypted for the current user.
// The child is put in a kill-on-close job, so it dies with this process
// even when the manager force-kills us. Every 2s a stats line is written:
//   \x01MCSTAT <cpuMs> <workingSetBytes>
// because the manager can't query another account's process itself.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

static class Program
{
    static readonly object WriteLock = new object();
    static Stream stdout;
    // Latin-1 maps every byte to one char, so output passes through unchanged.
    static readonly Encoding Bytes = Encoding.GetEncoding(28591);

    static int Main(string[] argv)
    {
        int sep = Array.IndexOf(argv, "--");
        if (sep != 2 || argv.Length < 4)
        {
            Console.Error.WriteLine("usage: mc-runas <credFile> <workDir> -- <exe> [args...]");
            return 2;
        }
        string user, password;
        try
        {
            byte[] plain = ProtectedData.Unprotect(File.ReadAllBytes(argv[0]), null, DataProtectionScope.CurrentUser);
            string[] parts = Encoding.UTF8.GetString(plain).Split(new[] { '\n' }, 2);
            user = parts[0].Trim();
            password = parts[1];
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("mc-runas: cannot read the account credentials (" + e.Message + "). Run the isolation setup again.");
            return 3;
        }

        var psi = new ProcessStartInfo
        {
            FileName = argv[3],
            Arguments = JoinArgs(argv, 4),
            WorkingDirectory = argv[1],
            UserName = user,
            Domain = ".",
            Password = ToSecure(password),
            LoadUserProfile = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Bytes,
            StandardErrorEncoding = Bytes,
        };

        Process child;
        try { child = Process.Start(psi); }
        catch (Exception e)
        {
            Console.Error.WriteLine("mc-runas: could not start the server as '" + user + "': " + e.Message);
            return 4;
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(info, ptr, false);
        SetInformationJobObject(job, 9, ptr, (uint)size); // JobObjectExtendedLimitInformation
        if (!AssignProcessToJobObject(job, child.Handle))
            Console.Error.WriteLine("mc-runas: warning: could not tie the server to this process (error " + Marshal.GetLastWin32Error() + ")");

        stdout = Console.OpenStandardOutput();
        var outT = new Thread(() => Relay(child.StandardOutput)) { IsBackground = true };
        var errT = new Thread(() => Relay(child.StandardError)) { IsBackground = true };
        outT.Start();
        errT.Start();

        var stdinStream = child.StandardInput.BaseStream;
        new Thread(() =>
        {
            var input = Console.OpenStandardInput();
            var buf = new byte[4096];
            try
            {
                int n;
                while ((n = input.Read(buf, 0, buf.Length)) > 0)
                {
                    stdinStream.Write(buf, 0, n);
                    stdinStream.Flush();
                }
                stdinStream.Close();
            }
            catch { }
        }) { IsBackground = true }.Start();

        // Process.TotalProcessorTime/WorkingSet64 open a fresh handle, which
        // Windows refuses for another account's process; the handle from
        // starting it has full access, so query through that.
        IntPtr h = child.Handle;
        while (!child.WaitForExit(2000))
        {
            long create, exit, kernel, usr;
            var mem = new PROCESS_MEMORY_COUNTERS { cb = (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS)) };
            if (GetProcessTimes(h, out create, out exit, out kernel, out usr) && K32GetProcessMemoryInfo(h, ref mem, mem.cb))
                WriteLine("\u0001MCSTAT " + (kernel + usr) / 10000 + " " + (ulong)mem.WorkingSetSize);
        }
        outT.Join(3000);
        errT.Join(3000);
        return child.ExitCode;
    }

    static void Relay(StreamReader reader)
    {
        try
        {
            string line;
            while ((line = reader.ReadLine()) != null) WriteLine(line);
        }
        catch { }
    }

    static void WriteLine(string line)
    {
        byte[] b = Bytes.GetBytes(line + "\n");
        lock (WriteLock)
        {
            try { stdout.Write(b, 0, b.Length); stdout.Flush(); } catch { }
        }
    }

    // Windows command-line quoting (the rules CommandLineToArgvW reverses).
    static string JoinArgs(string[] a, int from)
    {
        var sb = new StringBuilder();
        for (int i = from; i < a.Length; i++)
        {
            if (sb.Length > 0) sb.Append(' ');
            string s = a[i];
            if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(s); continue; }
            sb.Append('"');
            int slashes = 0;
            foreach (char c in s)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') sb.Append('\\', slashes * 2 + 1);
                else sb.Append('\\', slashes);
                slashes = 0;
                sb.Append(c);
            }
            sb.Append('\\', slashes * 2);
            sb.Append('"');
        }
        return sb.ToString();
    }

    static SecureString ToSecure(string s)
    {
        var ss = new SecureString();
        foreach (char c in s) ss.AppendChar(c);
        ss.MakeReadOnly();
        return ss;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_MEMORY_COUNTERS
    {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
            QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage;
    }

    [DllImport("kernel32.dll")]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll")]
    static extern bool K32GetProcessMemoryInfo(IntPtr process, ref PROCESS_MEMORY_COUNTERS counters, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attrs, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
