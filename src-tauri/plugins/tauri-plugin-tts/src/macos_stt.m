#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>

// ── Serial queue protecting all STT state ────────────────────────────
// Every public function dispatches to this queue so that start / stop /
// cancel / result-handler cleanups never race each other.

static dispatch_queue_t stt_queue(void) {
    static dispatch_queue_t q;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        q = dispatch_queue_create("ai.jan.stt", DISPATCH_QUEUE_SERIAL);
    });
    return q;
}

// ── Global state (only mutate on stt_queue) ─────────────────────────

static AVAudioEngine *g_audioEngine = nil;
static SFSpeechRecognizer *g_recognizer = nil;
static SFSpeechAudioBufferRecognitionRequest *g_request = nil;
static SFSpeechRecognitionTask *g_task = nil;

typedef void (*SttResultCallback)(const char *text, bool is_final, const char *error);
static SttResultCallback g_callback = NULL;

/// Monotonically increasing session counter. Incremented every time a new
/// recognition task is created (in stt_start / stt_restart). The result
/// handler captures the current value at task-creation time so that a
/// deferred cleanup from an old session cannot nil a newer session's state.
static uint64_t g_generation = 0;

// ── Session-level cleanup (MUST run on stt_queue) ─────────────────────
// Nils task + request only. Engine and recognizer stay alive for restart.
// Skips cleanup if a newer session has already replaced this one.

static void stt_end_task_if_current(uint64_t gen) {
    if (g_generation != gen) return;  // stale session — skip
    g_request = nil;
    g_task = nil;
}

// ── Full teardown (MUST run on stt_queue) ─────────────────────────────
// Tears down everything including engine and recognizer.
// Idempotent — safe to call multiple times.

static void stt_full_teardown(void) {
    // 1. Capture and nil the engine first. [stop] is synchronous and
    //    guarantees no more audio-tap callbacks after it returns.
    AVAudioEngine *engine = g_audioEngine;
    g_audioEngine = nil;

    if (engine) {
        if (engine.isRunning) {
            [engine stop];
        }
        @try {
            [engine.inputNode removeTapOnBus:0];
        } @catch (NSException *e) {
            // Tap may not be installed
        }
    }

    // 2. Clear session-level state
    g_request = nil;
    g_task = nil;

    // 3. Clear recognizer
    g_recognizer = nil;
}

// ── Authorization ────────────────────────────────────────────────────

/// Returns: 0 = not determined, 1 = authorized, 2 = denied, 3 = restricted
int stt_authorization_status(void) {
    SFSpeechRecognizerAuthorizationStatus status = [SFSpeechRecognizer authorizationStatus];
    switch (status) {
        case SFSpeechRecognizerAuthorizationStatusNotDetermined: return 0;
        case SFSpeechRecognizerAuthorizationStatusAuthorized:    return 1;
        case SFSpeechRecognizerAuthorizationStatusDenied:        return 2;
        case SFSpeechRecognizerAuthorizationStatusRestricted:    return 3;
        default: return -1;
    }
}

/// Request speech recognition authorization. Blocks until user responds.
/// Returns true if authorized.
bool stt_request_authorization(void) {
    SFSpeechRecognizerAuthorizationStatus status = [SFSpeechRecognizer authorizationStatus];

    if (status == SFSpeechRecognizerAuthorizationStatusAuthorized) {
        return true;
    }
    if (status != SFSpeechRecognizerAuthorizationStatusNotDetermined) {
        return false;
    }

    __block BOOL granted = NO;
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);

    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus authStatus) {
        granted = (authStatus == SFSpeechRecognizerAuthorizationStatusAuthorized);
        dispatch_semaphore_signal(sema);
    }];

    dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
    return granted;
}

// ── Start recognition ────────────────────────────────────────────────

bool stt_start(SttResultCallback callback, const char *language) {
    // Copy the language string before dispatching (it may be freed by caller)
    NSString *langStr = nil;
    if (language) {
        langStr = [NSString stringWithUTF8String:language];
    }

    __block bool ok = false;

    dispatch_sync(stt_queue(), ^{
        // Cancel any existing session
        if (g_task) {
            [g_task cancel];
        }
        stt_full_teardown();

        g_callback = callback;

        // Create recognizer with locale
        NSLocale *locale = nil;
        if (langStr.length > 0) {
            locale = [[NSLocale alloc] initWithLocaleIdentifier:langStr];
        }

        g_recognizer = locale
            ? [[SFSpeechRecognizer alloc] initWithLocale:locale]
            : [[SFSpeechRecognizer alloc] init];

        if (!g_recognizer || !g_recognizer.isAvailable) {
            if (g_callback) {
                g_callback(NULL, false, "Speech recognizer is not available for this language");
            }
            stt_full_teardown();
            return;
        }

        // Create recognition request
        g_request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
        g_request.shouldReportPartialResults = YES;

        // Prefer on-device recognition if available
        if (g_recognizer.supportsOnDeviceRecognition) {
            g_request.requiresOnDeviceRecognition = YES;
        }

        // Set up audio engine
        g_audioEngine = [[AVAudioEngine alloc] init];
        AVAudioInputNode *inputNode = g_audioEngine.inputNode;
        AVAudioFormat *format = [inputNode outputFormatForBus:0];

        [inputNode installTapOnBus:0
                        bufferSize:1024
                            format:format
                             block:^(AVAudioPCMBuffer *buffer, __unused AVAudioTime *when) {
            // Audio render thread — take a strong local ref to survive
            // concurrent nilling of the global on stt_queue.
            SFSpeechAudioBufferRecognitionRequest *req = g_request;
            if (req) {
                [req appendAudioPCMBuffer:buffer];
            }
        }];

        // Start recognition task
        g_generation++;
        uint64_t thisGen = g_generation;

        g_task = [g_recognizer recognitionTaskWithRequest:g_request
                                           resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
            // Fires on the Speech framework's internal queue.
            // Read callback pointer once (atomic pointer read on ARM64).
            SttResultCallback cb = g_callback;
            if (!cb) return;

            BOOL shouldCleanup = NO;

            if (result) {
                NSString *text = result.bestTranscription.formattedString;
                const char *utf8 = [text UTF8String];
                bool isFinal = result.isFinal;

                if (utf8) {
                    cb(utf8, isFinal, NULL);
                }

                if (isFinal) {
                    shouldCleanup = YES;
                }
            }

            if (error) {
                // Don't report cancellation errors (user-initiated stop)
                if (error.code == 216 || error.code == 1110) {
                    // Recognition timeout — report as ended, not error
                    cb(NULL, true, NULL);
                } else if (error.code != 301) {
                    // 301 = recognition cancelled (user-initiated)
                    const char *errMsg = [error.localizedDescription UTF8String];
                    if (errMsg) {
                        cb(NULL, false, errMsg);
                    }
                }
                shouldCleanup = YES;
            }

            if (shouldCleanup) {
                dispatch_async(stt_queue(), ^{
                    stt_end_task_if_current(thisGen);
                });
            }
        }];

        // Start the audio engine
        NSError *engineError = nil;
        [g_audioEngine prepare];
        if (![g_audioEngine startAndReturnError:&engineError]) {
            const char *errMsg = engineError
                ? [engineError.localizedDescription UTF8String]
                : "Failed to start audio engine";
            if (g_callback) {
                g_callback(NULL, false, errMsg);
            }
            stt_full_teardown();
            return;
        }

        ok = true;
    });

    return ok;
}

// ── Stop recognition (graceful — allows final result) ────────────────

void stt_stop(void) {
    dispatch_sync(stt_queue(), ^{
        // Capture and nil g_request so the audio tap stops appending
        // buffers. endAudio must not race with appendAudioPCMBuffer.
        SFSpeechAudioBufferRecognitionRequest *req = g_request;
        g_request = nil;
        if (req) {
            [req endAudio];
        }
        // The recognition task's result handler will fire with isFinal=YES
        // and then stt_end_task_if_current() will be dispatched from there.
        // Engine stays running for restart.
    });
}

// ── Restart recognition (reuse engine) ──────────────────────────────
// Cancels the old task and creates a new request + task on the existing
// engine. Returns false if the engine is dead/missing (caller should
// fall back to a full stt_start).

bool stt_restart(SttResultCallback callback, const char *language) {
    NSString *langStr = nil;
    if (language) {
        langStr = [NSString stringWithUTF8String:language];
    }

    __block bool ok = false;

    dispatch_sync(stt_queue(), ^{
        // Engine must be alive
        if (!g_audioEngine || !g_audioEngine.isRunning) {
            return;
        }

        // Cancel old task
        if (g_task) {
            [g_task cancel];
            g_task = nil;
        }
        g_request = nil;

        g_callback = callback;

        // Recreate recognizer if language changed or it's gone
        if (!g_recognizer) {
            NSLocale *locale = nil;
            if (langStr.length > 0) {
                locale = [[NSLocale alloc] initWithLocaleIdentifier:langStr];
            }
            g_recognizer = locale
                ? [[SFSpeechRecognizer alloc] initWithLocale:locale]
                : [[SFSpeechRecognizer alloc] init];
        }

        if (!g_recognizer || !g_recognizer.isAvailable) {
            return;
        }

        // New request
        g_request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
        g_request.shouldReportPartialResults = YES;
        if (g_recognizer.supportsOnDeviceRecognition) {
            g_request.requiresOnDeviceRecognition = YES;
        }

        // New task — reuses existing engine + tap
        g_generation++;
        uint64_t thisGen = g_generation;

        g_task = [g_recognizer recognitionTaskWithRequest:g_request
                                           resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
            SttResultCallback cb = g_callback;
            if (!cb) return;

            BOOL shouldCleanup = NO;

            if (result) {
                NSString *text = result.bestTranscription.formattedString;
                const char *utf8 = [text UTF8String];
                bool isFinal = result.isFinal;

                if (utf8) {
                    cb(utf8, isFinal, NULL);
                }

                if (isFinal) {
                    shouldCleanup = YES;
                }
            }

            if (error) {
                if (error.code == 216 || error.code == 1110) {
                    cb(NULL, true, NULL);
                } else if (error.code != 301) {
                    const char *errMsg = [error.localizedDescription UTF8String];
                    if (errMsg) {
                        cb(NULL, false, errMsg);
                    }
                }
                shouldCleanup = YES;
            }

            if (shouldCleanup) {
                dispatch_async(stt_queue(), ^{
                    stt_end_task_if_current(thisGen);
                });
            }
        }];

        ok = true;
    });

    return ok;
}

// ── Cancel recognition but keep engine alive ────────────────────────
// Cancels the current recognition task but preserves AVAudioEngine,
// recognizer, audio tap, and callback so that stt_restart() can create
// a new session without a full engine rebuild (and without triggering
// a new microphone access event).

void stt_cancel_keep_engine(void) {
    dispatch_sync(stt_queue(), ^{
        if (g_task) {
            [g_task cancel];
            g_task = nil;
        }
        g_request = nil;
        // Engine, recognizer, and callback stay alive for restart
    });
}

// ── Cancel recognition (immediate) ──────────────────────────────────

void stt_cancel(void) {
    dispatch_sync(stt_queue(), ^{
        if (g_task) {
            [g_task cancel];
        }
        stt_full_teardown();
        g_callback = NULL;
    });
}
