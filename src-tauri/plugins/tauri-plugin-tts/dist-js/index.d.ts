export interface TtsStartResult {
    port: number;
    pid: number;
}
export declare function startTtsServer(): Promise<TtsStartResult>;
export declare function stopTtsServer(): Promise<void>;
export declare function getTtsPort(): Promise<number>;
export declare function isTtsRunning(): Promise<boolean>;
