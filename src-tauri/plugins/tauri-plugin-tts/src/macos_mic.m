#import <AVFoundation/AVFoundation.h>

/// Returns: 0 = not determined, 1 = authorized, 2 = denied, 3 = restricted
int mic_authorization_status(void) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    switch (status) {
        case AVAuthorizationStatusNotDetermined: return 0;
        case AVAuthorizationStatusAuthorized:    return 1;
        case AVAuthorizationStatusDenied:        return 2;
        case AVAuthorizationStatusRestricted:    return 3;
        default: return -1;
    }
}

/// Synchronously request microphone access. Returns true if granted.
/// If status is already determined, returns the cached result immediately.
/// If not determined, shows the macOS TCC permission dialog.
///
/// The permission request is dispatched to the main thread because macOS
/// requires TCC dialogs to be presented from the main run loop. When called
/// from a background thread (e.g. Tokio's blocking pool), the dialog may
/// fail to appear if not dispatched to the main queue.
bool request_mic_access(void) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];

    if (status == AVAuthorizationStatusAuthorized) {
        return true;
    }
    if (status != AVAuthorizationStatusNotDetermined) {
        // Denied or restricted — can't re-prompt
        return false;
    }

    // Not yet determined — trigger the system dialog on the main thread
    __block BOOL granted = NO;
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);

    if ([NSThread isMainThread]) {
        // Already on the main thread — call directly
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                                 completionHandler:^(BOOL result) {
            granted = result;
            dispatch_semaphore_signal(sema);
        }];
    } else {
        // Dispatch to main thread so the TCC dialog can be presented
        dispatch_async(dispatch_get_main_queue(), ^{
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                                     completionHandler:^(BOOL result) {
                granted = result;
                dispatch_semaphore_signal(sema);
            }];
        });
    }

    dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
    return granted;
}
