import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './contract.js';
import { durableJson, syncDirectory } from './generation-journal.js';

const owned = new Map();
function bootIdentity() { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } }
function processIdentity(pid) {
    try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; }
}
function claimData(claim) {
    try {
        const stat = fs.lstatSync(claim);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Invalid owner');
        const file = stat.isDirectory() ? path.join(claim, 'owner.json') : claim;
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Invalid owner');
        const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || typeof prior.nonce !== 'string') throw new Error('Invalid owner');
        return prior;
    } catch { throw new ApiError(409, 'conflict', 'The previous generation owner cannot be proven stopped.'); }
}
function liveOwner(claim) {
    const prior = claimData(claim);
    const boot = bootIdentity();
    if (prior.boot && boot && prior.boot !== boot) return false;
    const identity = processIdentity(prior.pid);
    if (prior.start && identity && prior.start !== identity) return false;
    try { process.kill(prior.pid, 0); return true; } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw new ApiError(409, 'conflict', 'The previous generation owner cannot be proven stopped.');
    }
}
const occupied = error => ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code);

/** Rename a fully prepared nonempty directory: Android blocks hard links. */
export function acquireGenerationOwner(root) {
    root = path.resolve(root);
    if (owned.has(root)) {
        const claim = claimData(path.join(root, '.generation-owner.lock'));
        if (claim.pid !== process.pid || claim.nonce !== owned.get(root)) throw new ApiError(409, 'conflict', 'Generation ownership changed; the previous writer cannot continue.');
        return;
    }
    fs.mkdirSync(root, { recursive: true });
    const nonce = crypto.randomUUID();
    const owner = path.join(root, `.generation-owner-${process.pid}-${nonce}`);
    const guardCandidate = `${owner}-guard`;
    const claim = path.join(root, '.generation-owner.lock');
    const reclaim = path.join(root, '.generation-owner.reclaim');
    const metadata = { pid: process.pid, nonce, boot: bootIdentity(), start: processIdentity(process.pid) };
    durableJson(path.join(owner, 'owner.json'), metadata);
    try {
        try { fs.renameSync(owner, claim); } catch (error) {
            if (!occupied(error)) throw error;
            if (liveOwner(claim)) throw new ApiError(409, 'conflict', 'Another live process owns this companion generation directory.');
            // A nonempty recovery directory cannot be overwritten by another
            // rename. Interrupted recovery is retained for explicit inspection.
            durableJson(path.join(guardCandidate, 'owner.json'), metadata);
            try { fs.renameSync(guardCandidate, reclaim); } catch {
                throw new ApiError(409, 'conflict', 'Generation owner recovery is already in progress or requires inspection.');
            }
            syncDirectory(root);
            try {
                if (fs.existsSync(claim)) {
                    if (liveOwner(claim)) throw new ApiError(409, 'conflict', 'Another live process acquired generation ownership.');
                    const stale = `${claim}.stale-${nonce}`;
                    fs.renameSync(claim, stale);
                    syncDirectory(root);
                    fs.rmSync(stale, { recursive: true });
                }
                try { fs.renameSync(owner, claim); } catch {
                    throw new ApiError(409, 'conflict', 'Generation ownership changed while starting the backend.');
                }
                syncDirectory(root);
            } finally {
                // Never recursively delete the canonical name: another process
                // may create its next guard after this atomic rename.
                const released = `${reclaim}.released-${nonce}`;
                fs.renameSync(reclaim, released);
                syncDirectory(root);
                fs.rmSync(released, { recursive: true });
            }
        }
        syncDirectory(root);
        owned.set(root, nonce);
    } finally {
        fs.rmSync(owner, { recursive: true, force: true });
        fs.rmSync(guardCandidate, { recursive: true, force: true });
    }
}
