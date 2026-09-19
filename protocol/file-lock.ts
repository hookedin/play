import fs from 'node:fs';
import path from 'node:path';

/** Exclusive create; stale locks require supervised removal, never auto-reclaim. */
export function acquireServerLock(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Canonicalize parent aliases so all users of the same directory see one lock.
  file = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('Invalid server lock');
    const value = fs.readFileSync(file, 'utf8');
    if (!/^[1-9][0-9]*$/.test(value))
      throw new Error('Incomplete server lock; stop all writers and inspect before supervised removal: ' + file);
    try {
      process.kill(Number(value), 0);
      throw new Error('Server is already running');
    } catch (error: any) {
      if (error.code !== 'ESRCH') throw error;
    }
    throw new Error(
      'Stale server lock; stop all writers and verify exclusive ownership before supervised removal: ' + file,
    );
  }
  let inode;
  try {
    fs.writeFileSync(fd, String(process.pid));
    fs.fsyncSync(fd);
    inode = fs.fstatSync(fd).ino;
  } finally {
    fs.closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (fs.lstatSync(file).ino === inode) fs.unlinkSync(file);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}
