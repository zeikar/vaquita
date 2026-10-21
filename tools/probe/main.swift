// WKWebView probe for vaquita Phase 0: Korean IME (mode "ime") and background throttling (mode "throttle").
// usage: [VQ_FIX=1] vqtest <ime|throttle|throttle2> <test.html> <log file> [minimizeSeconds]
import Cocoa
import WebKit

let args = CommandLine.arguments
let mode = args[1]
let htmlURL = URL(fileURLWithPath: args[2])
let logPath = args[3]
let minimizeSeconds = args.count > 4 ? Double(args[4])! : 360
// A file URL can't carry test.html's ?fix=1, so the Hangul fix is switched on from the environment.
let hangulFix = ProcessInfo.processInfo.environment["VQ_FIX"] == "1"

final class Logger {
    let fh: FileHandle
    let t0 = Date()
    init(_ path: String) {
        FileManager.default.createFile(atPath: path, contents: nil)
        fh = FileHandle(forWritingAtPath: path)!
    }
    func log(_ s: String) {
        let line = String(format: "%.3f ", Date().timeIntervalSince1970) + s + "\n"
        fh.write(line.data(using: .utf8)!)
    }
}
let logger = Logger(logPath)

final class Handler: NSObject, WKScriptMessageHandler {
    let label: String
    init(_ label: String) { self.label = label }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        logger.log("[\(label)] \(m.body)")
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var windows: [(label: String, window: NSWindow, view: WKWebView)] = []
    var handlers: [Handler] = []
    var seq = 0
    var activity: NSObjectProtocol?

    func makeWindow(label: String, policyNone: Bool, origin: NSPoint, size: NSSize) {
        let cfg = WKWebViewConfiguration()
        let h = Handler(label)
        handlers.append(h)
        cfg.userContentController.add(h, name: "log")
        let boot = "window.VQ = {label: '\(label)', mode: '\(mode)', fix: \(hangulFix)};"
        cfg.userContentController.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if policyNone {
            cfg.preferences.inactiveSchedulingPolicy = .none
        }
        let frame = NSRect(origin: .zero, size: size)
        let view = WKWebView(frame: frame, configuration: cfg)
        let window = NSWindow(contentRect: NSRect(origin: origin, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "vaquita probe \(label)"
        window.contentView = view
        window.isReleasedWhenClosed = false
        window.delegate = self
        if mode == "throttle2" {
            view.load(URLRequest(url: URL(string: "http://127.0.0.1:8766/test.html")!))
        } else {
            view.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        }
        windows.append((label, window, view))
        logger.log("window \(label) inactiveSchedulingPolicy=\(policyNone ? "none" : "default") pid=\(ProcessInfo.processInfo.processIdentifier)")
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        if mode == "ime" {
            makeWindow(label: "IME", policyNone: true, origin: NSPoint(x: 200, y: 200), size: NSSize(width: 820, height: 420))
            windows[0].window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        // In throttle2 the server drives probes, so the app stays as nap-able as a real Tauri app.
        if mode == "throttle" {
            activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "vaquita throttle probe driver")
        }
        makeWindow(label: "A-none", policyNone: true, origin: NSPoint(x: 40, y: 40), size: NSSize(width: 420, height: 160))
        makeWindow(label: "B-default", policyNone: false, origin: NSPoint(x: 480, y: 40), size: NSSize(width: 420, height: 160))
        for w in windows { w.window.orderFront(nil) }

        if mode == "throttle" { Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            self.seq += 1
            for w in self.windows {
                let s = self.seq
                logger.log("[\(w.label)] send \(s)")
                w.view.evaluateJavaScript("window.vqProbe && vqProbe(\(s))", completionHandler: nil)
            }
        } }
        let phases: [(Double, String, () -> Void)] = [
            (8, "minimize", { for w in self.windows { w.window.miniaturize(nil) } }),
            (8 + minimizeSeconds, "restore", { for w in self.windows { w.window.deminiaturize(nil) } }),
            (8 + minimizeSeconds + 15, "hide", { for w in self.windows { w.window.orderOut(nil) } }),
            (8 + minimizeSeconds + 45, "show", { for w in self.windows { w.window.orderFront(nil) } }),
            (8 + minimizeSeconds + 55, "back", { for w in self.windows { w.window.orderBack(nil) } }),
            (8 + minimizeSeconds + 85, "end", { NSApp.terminate(nil) }),
        ]
        for (at, name, action) in phases {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                logger.log("STATE \(name)")
                action()
            }
        }
    }

    func windowWillClose(_ n: Notification) {
        if mode == "ime" { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
