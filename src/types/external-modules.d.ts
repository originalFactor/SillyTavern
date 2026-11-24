declare module 'seedrandom' {
    function seedrandom(seed?: string | number): (() => number) & { int32(): number };
    export default seedrandom;
}

declare module 'droll' {
    const droll: any;
    export default droll;
}

declare module 'ws' {
    export class WebSocketServer {
        constructor(options?: any);
        on(event: string, listener: (...args: any[]) => void): this;
        emit(event: string, ...args: any[]): boolean;
        handleUpgrade(request: any, socket: any, head: Buffer, callback: (socket: any) => void): void;
        close(callback?: (error?: Error) => void): void;
    }
}
