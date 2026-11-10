// The `node` export condition: the web core plus an encrypted file store.
import { defaultCacheDir, FileStore } from './node/file-store';
import { hooks } from './platform/hooks';

hooks.defaultStore = ({ platform }) => new FileStore(defaultCacheDir(platform));

export * from './index';
