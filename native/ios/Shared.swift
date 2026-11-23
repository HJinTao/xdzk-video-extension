import Foundation

enum CourseInbox {
    static var storage: UserDefaults? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "XDZKGroup") as? String else { return nil }
        return UserDefaults(suiteName: group)
    }
    static let key = "pendingCourse"
    static func course(_ text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        return detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap(\.url).first {
            ["http", "https"].contains($0.scheme?.lowercased() ?? "") && $0.host?.lowercased() == "newes.chaoxing.com"
                && $0.user == nil && $0.password == nil && $0.path.hasPrefix("/xidianpj/")
        }
    }
}
