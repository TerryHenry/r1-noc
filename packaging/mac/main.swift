// R1 NOC Wall — menu-bar launcher. Runs the bundled Node.js server and keeps it alive.
// Code lives in ~/Library/Application Support/R1 NOC Wall/app (copied from the bundle on first run and whenever the bundle is newer),
// so in-place upgrades from the editor work and survive app updates. Data (settings, layout, history) is in .../data.
import Cocoa

let fm = FileManager.default
var signalSources: [DispatchSourceSignal] = []
let support: URL = {
    if let o = ProcessInfo.processInfo.environment["R1NOC_SUPPORT"] { return URL(fileURLWithPath: o) }
    return fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("R1 NOC Wall")
}()
let appDir = support.appendingPathComponent("app"), dataDir = support.appendingPathComponent("data"), logFile = support.appendingPathComponent("server.log")
let res = Bundle.main.resourceURL!
let launchAgent = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/local.r1noc.wall.plist")

func version(of dir: URL) -> String {
    guard let d = try? Data(contentsOf: dir.appendingPathComponent("package.json")),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let v = j["version"] as? String else { return "0" }
    return v
}
func newer(_ a: String, than b: String) -> Bool { a.compare(b, options: .numeric) == .orderedDescending }

func seedIfNeeded() {
    try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
    let bundled = res.appendingPathComponent("app")
    if !fm.fileExists(atPath: appDir.appendingPathComponent("server.js").path) || newer(version(of: bundled), than: version(of: appDir)) {
        try? fm.removeItem(at: appDir)
        try? fm.copyItem(at: bundled, to: appDir)
    }
}
func portFree(_ p: Int) -> Bool {
    let s = socket(AF_INET, SOCK_STREAM, 0); if s < 0 { return false }; defer { close(s) }
    var yes: Int32 = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var a = sockaddr_in(); a.sin_family = sa_family_t(AF_INET); a.sin_port = in_port_t(p).bigEndian; a.sin_addr.s_addr = INADDR_ANY
    return withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
}
func choosePort() -> Int {
    let f = support.appendingPathComponent("port")
    if let t = try? String(contentsOf: f, encoding: .utf8), let p = Int(t.trimmingCharacters(in: .whitespacesAndNewlines)) { return p }   // remembered (also lets you pin a port by editing this file)
    for p in 8080...8099 where portFree(p) { try? String(p).write(to: f, atomically: true, encoding: .utf8); return p }
    return 8080
}

final class Delegate: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!; var child: Process?; var quitting = false; var port = 8080; var restarts = 0; var started = Date()
    func applicationDidFinishLaunching(_ n: Notification) {
        seedIfNeeded(); port = choosePort()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "R1"; item.button?.toolTip = "R1 NOC Wall"
        buildMenu(); start()
        if !fm.fileExists(atPath: support.appendingPathComponent(".opened").path) { fm.createFile(atPath: support.appendingPathComponent(".opened").path, contents: nil); DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.open("/admin") } }
    }
    func start() {
        let node = res.appendingPathComponent("node")
        let p = Process(); p.executableURL = node; p.arguments = [appDir.appendingPathComponent("server.js").path]; p.currentDirectoryURL = appDir
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port); env["NOC_DATA_DIR"] = dataDir.path; env["NOC_RESTART"] = "exit"; env["NOC_SUPERVISED"] = "1"; env["NOC_PARENT_PID"] = String(getpid())
        p.environment = env
        if !fm.fileExists(atPath: logFile.path) { fm.createFile(atPath: logFile.path, contents: nil) }
        if let h = try? FileHandle(forWritingTo: logFile) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
        p.terminationHandler = { [weak self] pr in DispatchQueue.main.async { self?.exited(pr.terminationStatus) } }
        do { try p.run(); child = p; started = Date(); refreshStatus("running on port \(port)") } catch { refreshStatus("cannot start: \(error.localizedDescription)") }
    }
    func exited(_ status: Int32) {
        if quitting { return }
        // exit 0 after an in-app upgrade → restart straight away; crashes back off so a broken install doesn't spin
        let quick = Date().timeIntervalSince(started) < 15; restarts = quick ? restarts + 1 : 0
        if restarts > 5 { refreshStatus("stopped (crashed \(restarts)×) — see the log"); return }
        refreshStatus("restarting…"); DispatchQueue.main.asyncAfter(deadline: .now() + (status == 0 ? 0.5 : 3)) { seedIfNeeded(); self.start() }
    }
    var statusLine: NSMenuItem!
    func refreshStatus(_ s: String) { statusLine?.title = "R1 NOC Wall — \(s)" }
    func buildMenu() {
        let m = NSMenu(); statusLine = NSMenuItem(title: "R1 NOC Wall", action: nil, keyEquivalent: ""); statusLine.isEnabled = false; m.addItem(statusLine); m.addItem(.separator())
        func add(_ t: String, _ a: Selector, _ k: String = "") { let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.target = self; m.addItem(i) }
        add("Open Wall", #selector(openWall)); add("Open Editor", #selector(openEditor)); m.addItem(.separator())
        add("Show Log", #selector(showLog)); add("Show Data Folder", #selector(showData))
        let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin(_:)), keyEquivalent: ""); login.target = self; login.state = fm.fileExists(atPath: launchAgent.path) ? .on : .off; m.addItem(login)
        m.addItem(.separator()); add("Quit R1 NOC Wall", #selector(quit), "q"); item.menu = m
    }
    func open(_ path: String) { NSWorkspace.shared.open(URL(string: "http://localhost:\(port)\(path)")!) }
    @objc func openWall() { open("/") }
    @objc func openEditor() { open("/admin") }
    @objc func showLog() { NSWorkspace.shared.open(logFile) }
    @objc func showData() { NSWorkspace.shared.activateFileViewerSelecting([dataDir]) }
    @objc func toggleLogin(_ s: NSMenuItem) {
        if fm.fileExists(atPath: launchAgent.path) { try? fm.removeItem(at: launchAgent); s.state = .off; return }
        let exe = Bundle.main.executablePath ?? ""
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>local.r1noc.wall</string><key>ProgramArguments</key><array><string>\(exe)</string></array><key>RunAtLoad</key><true/></dict></plist>"
        try? fm.createDirectory(at: launchAgent.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? plist.write(to: launchAgent, atomically: true, encoding: .utf8); s.state = .on
    }
    @objc func quit() { quitting = true; child?.terminate(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) } }
    func applicationWillTerminate(_ n: Notification) { quitting = true; child?.terminate() }
}
let del = Delegate()
for sig in [SIGTERM, SIGINT, SIGHUP] {   // `kill`, Activity Monitor "Quit", logout: stop the server too
    signal(sig, SIG_IGN); let src = DispatchSource.makeSignalSource(signal: sig, queue: .main); src.setEventHandler { del.quit() }; src.resume(); signalSources.append(src)
}
let app = NSApplication.shared; app.delegate = del; app.setActivationPolicy(.accessory); app.run()
