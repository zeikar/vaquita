//! Desktop notifications through UNUserNotificationCenter, used directly so a
//! click on one reaches the app however long after it was shown.
//!
//! The center may be used from any thread: `notify` runs on the main thread,
//! as Tauri runs commands that are not async, and `notification_permission`
//! on a blocking thread. macOS calls the delegate on a thread of its choosing,
//! so the delegate only holds the thread-safe AppHandle.

use std::ptr::NonNull;
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSNumber, NSString, NSUUID, ns_string};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSettings, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// The session a click selects; Target in src/lib/notify.ts. The daemon's sids are uint32.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Target {
    sid: u32,
    inc: String,
}

// The last clicked target, kept until the page takes it: a click that launches
// the app is delivered before the page listens or has its session list, and
// an event emitted then is lost.
static LAST_CLICK: Mutex<Option<Target>> = Mutex::new(None);

const NO_BUNDLE: &str = "not running from the app bundle, as in a `tauri dev` run";

// UNUserNotificationCenter aborts a process that is not an app bundle, such as
// a `tauri dev` binary, which also has no bundle identifier.
fn has_bundle() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and Delegate does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "VaquitaNotificationDelegate"]
    #[ivars = AppHandle]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    // SAFETY: the methods have the signatures the protocol declares.
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // Without it macOS shows nothing while the app is in front. List keeps
        // the notification in Notification Center, where it can still be clicked.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &DynBlock<dyn Fn()>,
        ) {
            // SAFETY: the framework defines the identifier as a constant string.
            let default_action = unsafe { UNNotificationDefaultActionIdentifier };
            if &*response.actionIdentifier() == default_action {
                let target = target_of(&response.notification().request().content().userInfo());
                *LAST_CLICK.lock().unwrap_or_else(|e| e.into_inner()) = target.clone();
                if let Err(e) = self.ivars().emit_to("main", "notification-click", target) {
                    eprintln!("vaquita: reporting a notification click failed: {e}");
                }
            }
            handler.call(());
        }
    }
);

// What a notification carries for its click to hand back.
fn user_info(t: &Target) -> Retained<NSDictionary<NSString, AnyObject>> {
    let sid = NSNumber::new_u32(t.sid);
    let inc = NSString::from_str(&t.inc);
    let values: [&AnyObject; 2] = [&sid, &inc];
    NSDictionary::from_slices(&[ns_string!("sid"), ns_string!("inc")], &values)
}

// What a clicked notification carries back; the missed summary carries nothing.
fn target_of(info: &NSDictionary) -> Option<Target> {
    let sid = info.objectForKey(ns_string!("sid"))?.downcast::<NSNumber>().ok()?;
    let inc = info.objectForKey(ns_string!("inc"))?.downcast::<NSString>().ok()?;
    Some(Target { sid: sid.as_u32(), inc: inc.to_string() })
}

fn log_error(what: &str, error: *mut NSError) {
    // SAFETY: the framework passes nil or an NSError that lives through the call.
    if let Some(e) = unsafe { error.as_ref() } {
        eprintln!("vaquita: {what} failed: {}", e.localizedDescription());
    }
}

// Hands clicks to the webview for as long as the app runs: as an event while
// the page listens, and through take_notification_click for one that came
// before. Without a bundle there are no notifications.
pub fn setup(app: &AppHandle) {
    if !has_bundle() {
        return;
    }
    let delegate = Delegate::alloc().set_ivars(app.clone());
    // SAFETY: NSObject's init on a freshly allocated object whose ivars are set.
    let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly, and this one answers for as long
    // as the app runs, so it is never released.
    std::mem::forget(delegate);
}

// The target of the last click that nobody has taken, once. A click macOS
// delivers before the app is running is lost; one it delivers during launch
// waits here.
#[tauri::command]
pub fn take_notification_click() -> Option<Target> {
    LAST_CLICK.lock().unwrap_or_else(|e| e.into_inner()).take()
}

// Whether macOS lets the app show notifications. The first time, macOS asks
// the user, which must not hold up the app's start, so the request is left
// running and counts as allowed: notifications sent before the user answers
// may be dropped, and nothing else waits for the answer.
#[tauri::command]
pub async fn notification_permission() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // This thread has no autorelease pool of its own.
        autoreleasepool(|_| {
            if !has_bundle() {
                return Err(NO_BUNDLE.to_string());
            }
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let (tx, rx) = mpsc::sync_channel(1);
            center.getNotificationSettingsWithCompletionHandler(&RcBlock::new(
                move |settings: NonNull<UNNotificationSettings>| {
                    // SAFETY: the framework passes settings that live through the call.
                    let status = unsafe { settings.as_ref() }.authorizationStatus();
                    // Fails only once the wait below has given up and said so.
                    let _ = tx.send(status);
                },
            ));
            let status = rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "macOS did not report the notification settings".to_string())?;
            if status == UNAuthorizationStatus::NotDetermined {
                // Only alerts: the notifications are sent silently.
                center.requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert,
                    &RcBlock::new(|_granted: Bool, error: *mut NSError| {
                        log_error("asking for notification permission", error)
                    }),
                );
            }
            Ok(status != UNAuthorizationStatus::Denied)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Shows a notification without waiting for macOS to show it, so a failure to
// show it, such as notifications being turned off, is only logged.
#[tauri::command]
pub fn notify(title: String, body: String, target: Option<Target>) -> Result<(), String> {
    if !has_bundle() {
        return Err(NO_BUNDLE.to_string());
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&title));
    content.setBody(&NSString::from_str(&body));
    if let Some(t) = &target {
        // SAFETY: userInfo takes any keys and values that are property-list
        // objects, as strings and numbers are.
        unsafe { content.setUserInfo(user_info(t).cast_unchecked()) };
    }
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSUUID::new().UUIDString(),
        &content,
        None,
    );
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(
        &request,
        Some(&RcBlock::new(|error: *mut NSError| log_error("showing a notification", error))),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_round_trips_through_user_info() {
        let t = Target { sid: 4_000_000_000, inc: "a1".into() };
        let content = UNMutableNotificationContent::new();
        // SAFETY: as in notify.
        unsafe { content.setUserInfo(user_info(&t).cast_unchecked()) };
        assert_eq!(target_of(&content.userInfo()), Some(t));
    }

    #[test]
    fn no_target_without_a_number_and_a_string() {
        assert_eq!(target_of(&NSDictionary::new()), None);
        let values: [&AnyObject; 2] = [&NSString::from_str("3"), &NSString::from_str("a")];
        let info = NSDictionary::from_slices(&[ns_string!("sid"), ns_string!("inc")], &values);
        // SAFETY: only read through target_of, which checks each value's class.
        assert_eq!(target_of(unsafe { info.cast_unchecked() }), None);
    }
}
