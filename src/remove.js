import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { SandboxError } from './errors.js';

// Contents models do not distinguish directories from directory symlinks.
// Never recursively DELETE their children. Use descriptor-relative filesystem
// operations instead, and prove that the terminal sees the same Contents root.
export async function removeTree(jupyter, remotePath) {
  validateRemovalPath(remotePath);
  const probe = `_nfdi_delete_probe_${crypto.randomBytes(16).toString('hex')}`;
  const marker = `NFDI_DELETE_${crypto.randomBytes(16).toString('hex')}:`;
  const source = `${REMOVE_TREE}\nremove_tree(${JSON.stringify(remotePath)}, sys.argv[1], sys.argv[2])\n`;
  const proof = crypto.createHash('sha256').update(source).digest('hex');
  // The uploaded task doubles as a proof of the Contents root. Verify its hash
  // before executing it, then verify it again relative to the deletion root fd.
  const bootstrap = `import hashlib, json, os, sys
try:
    p = os.path.join(os.path.expanduser(os.environ["JUPYTER_SERVER_ROOT"]), sys.argv[1])
    with os.fdopen(os.open(p, os.O_RDONLY | os.O_NOFOLLOW), "rb") as f:
        code = f.read()
    if hashlib.sha256(code).hexdigest() != sys.argv[2]:
        raise ValueError("terminal and Contents roots do not match")
    exec(code)
    result = {"ok": True}
except Exception as error:
    result = {"ok": False, "error": str(error)[:1000]}
print(${JSON.stringify(marker)} + json.dumps(result), flush=True)
`;
  // Only send a short bootstrap, not the task, through the PTY. Large pastes
  // can be corrupted by canonical-input limits even when split over lines.
  // Encoding also keeps the result marker out of echoed terminal input.
  const encoded = deflateSync(bootstrap).toString('base64');
  const command = `python3 -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode("${encoded}")))' ${probe} ${proof}`;
  let terminal;
  let ws;
  let timer;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // A failed connection/setup may prevent us from awaiting the result promise.
  result.catch(() => {});
  let output = '';
  const onMessage = (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!Array.isArray(message) || message[0] !== 'stdout' || typeof message[1] !== 'string') return;
    output = (output + message[1]).slice(-64 * 1024);
    const start = output.indexOf(marker);
    if (start < 0) return;
    const end = output.indexOf('\n', start);
    if (end < 0) return;
    try {
      const value = JSON.parse(output.slice(start + marker.length, end));
      if (value.ok === true) resolveResult();
      else rejectResult(new SandboxError('DELETE_FAILED', value.error || 'filesystem deletion failed'));
    } catch (error) {
      rejectResult(new SandboxError('INVALID_RESPONSE', `invalid deletion result: ${error.message}`));
    }
  };
  try {
    await jupyter.write(probe, source);
    terminal = await jupyter.createTerminal();
    ws = await jupyter.runTerminalCommand(terminal, command, { onMessage });
    ws.once('error', (error) => rejectResult(new SandboxError('DELETE_FAILED', error.message)));
    ws.once('close', () => rejectResult(new SandboxError('DELETE_FAILED', 'deletion terminal disconnected before confirmation')));
    timer = setTimeout(() => rejectResult(new SandboxError('DELETE_TIMEOUT', 'filesystem deletion was not confirmed within 120 seconds')), 120_000);
    await result;
  } finally {
    clearTimeout(timer);
    try { ws?.close(); } catch {}
    if (terminal !== undefined) await jupyter.deleteTerminal(terminal);
    // This is one ordinary file at the Contents root, never a client-side walk.
    await jupyter.request(`api/contents/${probe}`, { method: 'DELETE' }).catch(() => {});
  }
}

export function validateRemovalPath(remotePath) {
  if (typeof remotePath !== 'string' || !remotePath || remotePath.includes('\0') ||
      remotePath.startsWith('/') || remotePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new SandboxError('INVALID_ARGUMENT', 'deletion requires a non-root, relative path without empty, . or .. components');
  }
}

// Linux/macOS Python: open directory descriptors with O_NOFOLLOW, including all
// ancestors of the requested path. Symlinks at the leaf or inside the tree are
// unlinked, not traversed. Descriptor-relative recursion also avoids following
// a directory that is replaced by a symlink between listing and opening it.
export const REMOVE_TREE = String.raw`import errno
import hashlib
import os


def remove_tree(path, probe, proof):
    parts = path.split("/")
    if not path or any(p in ("", ".", "..") for p in parts) or "\0" in path:
        raise ValueError("unsafe deletion path")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root = os.path.expanduser(os.environ["JUPYTER_SERVER_ROOT"])
    if not os.path.isabs(root):
        raise ValueError("JUPYTER_SERVER_ROOT must be absolute")
    root_fd = os.open(root, flags)
    try:
        probe_fd = os.open(probe, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
        with os.fdopen(probe_fd, "rb") as stream:
            if hashlib.sha256(stream.read()).hexdigest() != proof:
                raise ValueError("terminal and Contents roots do not match")
        remove_path(root_fd, parts, flags)
    finally:
        os.close(root_fd)


def remove_path(parent, parts, flags):
    if len(parts) == 1:
        remove_entry(parent, parts[0], flags)
        return
    try:
        directory = os.open(parts[0], flags, dir_fd=parent)
    except FileNotFoundError:
        return
    try:
        remove_path(directory, parts[1:], flags)
    finally:
        os.close(directory)


def remove_entry(parent, name, flags):
    try:
        directory = os.open(name, flags, dir_fd=parent)
    except FileNotFoundError:
        return
    except OSError as error:
        if error.errno not in (errno.ELOOP, errno.ENOTDIR):
            raise
        try:
            os.unlink(name, dir_fd=parent)
        except FileNotFoundError:
            pass
        return
    try:
        for child in os.listdir(directory):
            remove_entry(directory, child, flags)
    finally:
        os.close(directory)
    os.rmdir(name, dir_fd=parent)
`;
