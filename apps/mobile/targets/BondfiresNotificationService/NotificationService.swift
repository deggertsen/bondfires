import Foundation
import UniformTypeIdentifiers
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var hasDeliveredContent = false
    private let stateLock = NSLock()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard
            let avatarURLString = request.content.userInfo["avatarUrl"] as? String,
            let avatarURL = URL(string: avatarURLString),
            avatarURL.scheme?.lowercased() == "https"
        else {
            deliverBestAttempt()
            return
        }

        URLSession.shared.downloadTask(with: avatarURL) { [weak self] location, response, error in
            guard let self else { return }
            defer { self.deliverBestAttempt() }

            guard
                error == nil,
                let location,
                let httpResponse = response as? HTTPURLResponse,
                (200 ..< 300).contains(httpResponse.statusCode),
                let content = self.bestAttemptContent
            else { return }

            let mimeType = httpResponse.mimeType?.lowercased() ?? ""
            guard mimeType.hasPrefix("image/") else { return }

            let imageType: UTType
            switch mimeType {
            case "image/png": imageType = .png
            case "image/gif": imageType = .gif
            case "image/heic", "image/heif": imageType = .heic
            case "image/tiff": imageType = .tiff
            default:
                let pathType = UTType(filenameExtension: avatarURL.pathExtension)
                imageType = pathType?.conforms(to: .image) == true ? pathType! : .jpeg
            }

            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("bondfires-avatar-\(UUID().uuidString)")
                .appendingPathExtension(imageType.preferredFilenameExtension ?? "jpg")

            do {
                try FileManager.default.copyItem(at: location, to: destination)
                let attachment = try UNNotificationAttachment(
                    identifier: "avatar",
                    url: destination,
                    options: [UNNotificationAttachmentOptionsTypeHintKey: imageType.identifier]
                )
                content.attachments = [attachment]
            } catch {
                // The original notification still displays if download or attachment fails.
            }
        }.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        deliverBestAttempt()
    }

    private func deliverBestAttempt() {
        stateLock.lock()
        guard
            !hasDeliveredContent,
            let contentHandler,
            let bestAttemptContent
        else {
            stateLock.unlock()
            return
        }
        hasDeliveredContent = true
        self.contentHandler = nil
        stateLock.unlock()

        contentHandler(bestAttemptContent)
    }
}
