#import "NotificationService.h"

@interface NotificationService ()

@property(nonatomic, strong) void (^contentHandler)(UNNotificationContent *contentToDeliver);
@property(nonatomic, strong) UNMutableNotificationContent *bestAttemptContent;

@end

@implementation NotificationService

- (void)didReceiveNotificationRequest:(UNNotificationRequest *)request
               withContentHandler:(void (^)(UNNotificationContent *_Nonnull))contentHandler {
  self.contentHandler = contentHandler;
  self.bestAttemptContent = [request.content mutableCopy];

  NSString *avatarUrlString = [self avatarUrlFromUserInfo:request.content.userInfo];
  if (avatarUrlString.length == 0) {
    self.contentHandler(self.bestAttemptContent);
    return;
  }

  NSURL *avatarURL = [NSURL URLWithString:avatarUrlString];
  if (!avatarURL) {
    self.contentHandler(self.bestAttemptContent);
    return;
  }

  NSURLSession *session = [NSURLSession sharedSession];
  [[session downloadTaskWithURL:avatarURL
              completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
                if (error || !location) {
                  self.contentHandler(self.bestAttemptContent);
                  return;
                }

                NSString *tmpDir = NSTemporaryDirectory();
                NSString *fileName =
                    [NSString stringWithFormat:@"bf-avatar-%@.jpg", [[NSUUID UUID] UUIDString]];
                NSURL *tmpURL = [NSURL fileURLWithPath:[tmpDir stringByAppendingPathComponent:fileName]];

                NSError *moveError = nil;
                [[NSFileManager defaultManager] removeItemAtURL:tmpURL error:nil];
                [[NSFileManager defaultManager] moveItemAtURL:location toURL:tmpURL error:&moveError];
                if (moveError) {
                  self.contentHandler(self.bestAttemptContent);
                  return;
                }

                NSError *attachError = nil;
                UNNotificationAttachment *attachment =
                    [UNNotificationAttachment attachmentWithIdentifier:@"avatar"
                                                                   URL:tmpURL
                                                               options:nil
                                                                 error:&attachError];
                if (attachment && !attachError) {
                  self.bestAttemptContent.attachments = @[ attachment ];
                }

                self.contentHandler(self.bestAttemptContent);
              }] resume];
}

- (void)serviceExtensionTimeWillExpire {
  if (self.contentHandler && self.bestAttemptContent) {
    self.contentHandler(self.bestAttemptContent);
  }
}

- (NSString *)avatarUrlFromUserInfo:(NSDictionary *)userInfo {
  id direct = userInfo[@"avatarUrl"];
  if ([direct isKindOfClass:[NSString class]] && [(NSString *)direct length] > 0) {
    return (NSString *)direct;
  }

  id data = userInfo[@"data"];
  if ([data isKindOfClass:[NSDictionary class]]) {
    id nested = ((NSDictionary *)data)[@"avatarUrl"];
    if ([nested isKindOfClass:[NSString class]] && [(NSString *)nested length] > 0) {
      return (NSString *)nested;
    }
  }

  // Expo / FCM sometimes stringifies nested data.
  if ([data isKindOfClass:[NSString class]]) {
    NSData *jsonData = [(NSString *)data dataUsingEncoding:NSUTF8StringEncoding];
    if (jsonData) {
      id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
      if ([parsed isKindOfClass:[NSDictionary class]]) {
        id nested = ((NSDictionary *)parsed)[@"avatarUrl"];
        if ([nested isKindOfClass:[NSString class]]) {
          return (NSString *)nested;
        }
      }
    }
  }

  return nil;
}

@end
