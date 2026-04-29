import Foundation

let notificationName = Notification.Name("ca.adamhayat.weavepdf.finder-action")
let ackNotificationName = Notification.Name("ca.adamhayat.weavepdf.finder-action-ack")
let center = DistributedNotificationCenter.default()

let token = center.addObserver(
    forName: notificationName,
    object: nil,
    queue: nil
) { notification in
    guard let url = notification.userInfo?["url"] as? String else { return }
    if let ackToken = notification.userInfo?["token"] as? String {
        center.postNotificationName(
            ackNotificationName,
            object: nil,
            userInfo: ["token": ackToken],
            deliverImmediately: true
        )
    }
    print(url)
    fflush(stdout)
}

RunLoop.main.run()

center.removeObserver(token)
