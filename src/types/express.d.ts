import type { UserDirectoryList } from '../users.js';

declare global {
    namespace Express {
        interface Request {
            session: Record<string, any> | null;
            file?: any;
            user: {
                directories: UserDirectoryList;
                [key: string]: any;
            };
        }
    }
}

export {};
