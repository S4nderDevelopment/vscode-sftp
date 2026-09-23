import * as util from 'util';
import { Uri, window } from 'vscode';
import logger from '../../logger';
import { reportError } from '../../helper';
import { handleCtxFromUri, allHandleCtxFromUri, FileHandlerContext } from '../../fileHandlers';
import { COMMAND_UPLOAD_FILE_TO_ALL_PROFILES, COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES } from '../../constants';
import Command from './command';

interface BaseCommandOption {
  id: string;
  name?: string;
}

interface CommandOption extends BaseCommandOption {
  handleCommand: (this: Command, ...args: any[]) => unknown | Promise<unknown>;
}

interface FileCommandOption extends BaseCommandOption {
  handleFile: (ctx: FileHandlerContext) => Promise<unknown>;
  getFileTarget: (...args: any[]) => undefined | Uri | Uri[] | Promise<undefined | Uri | Uri[]>;
}

function checkType<T>() {
  return (a: T) => a;
}

export const checkCommand = checkType<CommandOption>();
export const checkFileCommand = checkType<FileCommandOption>();

// TEMP DEBUG: remove once GitLens target-resolution issue is diagnosed
const SKIP_KEYS = new Set(['view', 'container', '_container', 'parent', 'root', 'context']);
const SKIP_CLASS_PATTERN = /Service$|Provider$|Controller$|Container$|View$|Emitter$|Tracker$/;
function safeDescribe(value: any, depth = 3, seen = new WeakSet<object>()): any {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Uri) {
    return `Uri(${value.toString()})`;
  }
  if (seen.has(value)) {
    return '<circular>';
  }
  const ctorName = value.constructor ? value.constructor.name : typeof value;
  if (depth <= 0) {
    return `<${ctorName}>`;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map(v => safeDescribe(v, depth - 1, seen));
    return value.length > 10 ? [...items, `<+${value.length - 10} more>`] : items;
  }

  const out: any = { $type: ctorName };
  for (const key of Object.keys(value)) {
    const raw = (value as any)[key];
    if (SKIP_KEYS.has(key) || (raw && raw.constructor && SKIP_CLASS_PATTERN.test(raw.constructor.name))) {
      out[key] = `<skipped ${raw && raw.constructor ? raw.constructor.name : typeof raw}>`;
      continue;
    }
    try {
      out[key] = safeDescribe(raw, depth - 1, seen);
    } catch {
      out[key] = '<unreadable>';
    }
  }
  return out;
}
function debugArgs(args: any[]): string {
  return util.inspect(args.map(a => safeDescribe(a)), { depth: null, breakLength: 120 });
}

export function createCommand(commandOption: CommandOption & { name: string }) {
  return class NormalCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    doCommandRun(...args) {
      commandOption.handleCommand.apply(this, args);
    }
  };
}

export function createFileCommand(commandOption: FileCommandOption & { name: string }) {
  return class FileCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    protected async doCommandRun(...args) {
      if ((this.id === COMMAND_UPLOAD_FILE_TO_ALL_PROFILES || this.id === COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES) 
        && await window.showInformationMessage('Are you sure you want to upload to all profiles?', 'Yes', 'No').then(answer => answer !== 'Yes')) {
        return;
      }
      
      // TEMP DEBUG: remove once GitLens target-resolution issue is diagnosed
      logger.warn(`[debug] "${this.name}" invoked with args:`, debugArgs(args));

      const target = await commandOption.getFileTarget(...args);
      if (!target) {
        logger.warn(`The "${this.name}" command get canceled because of missing targets.`);
        return;
      }

      const targetList: Uri[] = Array.isArray(target) ? target : [target];
      const pendingTasks = targetList.map(async uri => {
        try {
          await commandOption.handleFile(handleCtxFromUri(uri));
        } catch (error) {
          reportError(error);
        }
      });

      await Promise.all(pendingTasks);
    }
  };
}

export function createFileMultiCommand(commandOption: FileCommandOption & { name: string }) {
  return class FileCommand extends Command {
    constructor() {
      super();
      this.id = commandOption.id;
      this.name = commandOption.name;
    }

    protected async doCommandRun(...args) {
      if ((this.id === COMMAND_UPLOAD_FILE_TO_ALL_PROFILES || this.id === COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES) 
        && await window.showInformationMessage('Are you sure you want to upload to all profiles?', 'Yes', 'No').then(answer => answer !== 'Yes')) {
        return;
      }
      
      // TEMP DEBUG: remove once GitLens target-resolution issue is diagnosed
      logger.warn(`[debug] "${this.name}" invoked with args:`, debugArgs(args));

      const target = await commandOption.getFileTarget(...args);
      if (!target) {
        logger.warn(`The "${this.name}" command get canceled because of missing targets.`);
        return;
      }

      const targetList: Uri[] = Array.isArray(target) ? target : [target];
      const pendingTasks = targetList.map(async uri => {
        try {
          await Promise.all(allHandleCtxFromUri(uri).map(commandOption.handleFile));
        } catch (error) {
          reportError(error);
        }
      });

      await Promise.all(pendingTasks);
    }
  };
}
