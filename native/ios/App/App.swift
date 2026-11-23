import UIKit
import WebKit

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = CourseController()
        self.window = window
        window.makeKeyAndVisible()
        return true
    }
}

private let home = URL(string: "xdzk-app://localhost/mobile.html")!

private final class LocalPages: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "localhost",
              let root = Bundle.main.resourceURL?.appendingPathComponent("Resources/web/") else {
            task.didFailWithError(URLError(.badURL)); return
        }
        let file = root.appendingPathComponent(String(url.path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + (root.path.hasSuffix("/") ? "" : "/")),
              let bytes = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "png": "image/png"][file.pathExtension] ?? "text/plain"
        task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: bytes.count, textEncodingName: mime == "image/png" ? nil : "utf-8"))
        task.didReceive(bytes)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class CourseController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var web: WKWebView!
    private let bar = UIStackView()
    private var timer: Timer?
    private var attempts = 0, generation = 0
    private var lastSingle = ""
    private lazy var reader = (try? String(contentsOf: Bundle.main.bundleURL.appendingPathComponent("Resources/reader.js"), encoding: .utf8)) ?? "null"

    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.setURLSchemeHandler(LocalPages(), forURLScheme: "xdzk-app")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self; web.uiDelegate = self
        bar.distribution = .fillEqually
        for (text, action) in [("播放器首页", #selector(showHome)), ("播放这节课", #selector(playCourse))] {
            let b = UIButton(type: .system)
            b.setTitle(text, for: .normal); b.addTarget(self, action: action, for: .touchUpInside)
            bar.addArrangedSubview(b)
        }
        let stack = UIStackView(arrangedSubviews: [bar, web])
        stack.axis = .vertical
        view.backgroundColor = .systemBackground
        view.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: safe.topAnchor), stack.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: safe.leadingAnchor), stack.trailingAnchor.constraint(equalTo: safe.trailingAnchor)])
        let barHeight = bar.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        barHeight.priority = .defaultHigh
        barHeight.isActive = true
        bar.isHidden = true
        NotificationCenter.default.addObserver(self, selector: #selector(receiveCourse), name: UIApplication.didBecomeActiveNotification, object: nil)
        showHome()
    }
    @objc private func receiveCourse() {
        guard let store = CourseInbox.storage, let text = store.string(forKey: CourseInbox.key),
              let url = CourseInbox.course(text) else { return }
        store.removeObject(forKey: CourseInbox.key)
        web.load(URLRequest(url: url))
    }
    @objc private func showHome() { web.load(URLRequest(url: home)) }
    @objc private func playCourse() { collect(manual: true) }
    private func schedule() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in self?.collect(manual: false) }
    }
    private func hint(_ text: String) {
        let alert = UIAlertController(title: "智课看课", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default)); present(alert, animated: true)
    }
    private func collect(manual: Bool) {
        guard let url = web.url, url.host == "newes.chaoxing.com" else {
            if manual { hint("请先在应用内登录学校，再打开这节课的回放。") }
            return
        }
        timer?.invalidate()
        let request = generation
        web.evaluateJavaScript(reader) { [weak self] value, _ in
            guard let self = self, self.generation == request, self.web.url == url else { return }
            let lesson = value as? [String: Any]
            let media = lesson?["media"] as? [[String: Any]] ?? []
            let single = media.count == 1 ? media.first?["url"] as? String ?? "" : ""
            let ready = !single.isEmpty && single == self.lastSingle && lesson?["videoCount"] as? Int == 1
            self.lastSingle = single
            if let lesson = lesson, media.count == 2 || ready || (manual && media.count == 1),
               let bytes = try? JSONSerialization.data(withJSONObject: lesson),
               let encoded = String(data: bytes, encoding: .utf8)?.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
               let address = URL(string: home.absoluteString + "#lesson=" + encoded) {
                self.generation += 1; self.web.load(URLRequest(url: address)); return
            }
            if manual { self.hint("请进入具体课次并点播放，再点「播放这节课」。") }
            self.attempts += 1
            if self.attempts < 60 { self.schedule() }
        }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        generation += 1; attempts = 0; lastSingle = ""; timer?.invalidate()
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { bar.isHidden = web.url?.scheme == "xdzk-app" }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if web.url?.host == "newes.chaoxing.com" { schedule() }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = ["http", "https", "xdzk-app", "about", "blob"].contains(action.request.url?.scheme ?? "")
        if allowed && action.targetFrame == nil { web.load(action.request); decisionHandler(.cancel) }
        else { decisionHandler(allowed ? .allow : .cancel) }
    }
}
