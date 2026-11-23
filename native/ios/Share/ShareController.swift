import UIKit
import UniformTypeIdentifiers

final class ShareController: UIViewController {
    private var started = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        for type in [UTType.url.identifier, UTType.plainText.identifier] {
            if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(type) }) {
                provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
                    let raw = (item as? URL)?.absoluteString ?? (item as? String) ?? ""
                    DispatchQueue.main.async { self.receive(raw) }
                }
                return
            }
        }
        receive(items.compactMap { $0.attributedContentText?.string }.joined(separator: " "))
    }

    private func receive(_ text: String) {
        var message = "请分享西电智课的课程播放网址。"
        if let url = CourseInbox.course(text), let store = CourseInbox.storage {
            store.set(url.absoluteString, forKey: CourseInbox.key)
            message = "已收到课程。打开「智课看课」即可观看。"
        }
        let alert = UIAlertController(title: "智课看课", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "完成", style: .default) { _ in
            self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        })
        present(alert, animated: true)
    }
}
