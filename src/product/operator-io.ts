import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { atomicCreate } from '../infrastructure/filesystem/atomic-create.js';
import { atomicWrite } from '../infrastructure/filesystem/atomic-write.js';

export interface OperatorFileSystem {
  exists(path: string): boolean;
  lstat(path: string): Stats;
  realpath(path: string): string;
  readText(path: string): string;
  list(path: string): readonly string[];
  mkdir(path: string, options: { recursive: boolean; mode: number }): void;
  chmod(path: string, mode: number): void;
  createExclusive(path: string, content: string, mode: number): boolean;
  writePrivate(path: string, content: string): void;
  unlink(path: string): void;
}

export const nodeOperatorFileSystem: OperatorFileSystem = {
  exists: existsSync,
  lstat: lstatSync,
  realpath: realpathSync,
  readText: (path) => readFileSync(path, 'utf8'),
  list: readdirSync,
  mkdir: (path, options) => mkdirSync(path, options),
  chmod: chmodSync,
  createExclusive: (path, content, mode) =>
    atomicCreate({ filePath: path, content, mode }),
  writePrivate: (path, content) =>
    atomicWrite({ filePath: path, content, secretSensitive: true }),
  unlink: unlinkSync,
};
