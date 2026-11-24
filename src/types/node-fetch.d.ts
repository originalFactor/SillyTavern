import 'node-fetch';

declare module 'node-fetch' {
    interface Response {
        json(): Promise<any>;
    }
}
