import * as fs from 'fs';
import * as path from 'path';
import { Uri, window } from 'vscode';
import { FileType } from '../core';
import { getAllFileService, getFileService } from '../modules/serviceManager';
import { ExplorerItem } from '../modules/remoteExplorer';
import { getGitService, Repository, Status, Change } from '../modules/git';
import { getActiveTextEditor } from '../host';
import { listFiles, toLocalPath, simplifyPath } from '../helper';
import logger from '../logger';

function configIngoreFilterCreator(config) {
  if (!config || !config.ignore) {
    return;
  }

  return file => !config.ignore(file.fsPath);
}

function createFileSelector(filterCreator?) {
  return async (): Promise<Uri | undefined> => {
    const remoteItems = getAllFileService().map((fileService, index) => {
      const config = fileService.getConfig();
      return {
        name: config.name || config.remotePath,
        description: config.host,
        fsPath: config.remotePath,
        type: FileType.Directory,
        filter: filterCreator ? filterCreator(config) : undefined,
        getFs: () => fileService.getRemoteFileSystem(config),
        index,
        remoteBaseDir: config.remotePath,
        baseDir: fileService.baseDir,
      };
    });

    const selected = await listFiles(remoteItems);

    if (!selected) {
      return;
    }

    const rootItem = remoteItems[selected.index];
    const localTarget = toLocalPath(selected.fsPath, rootItem.remoteBaseDir, rootItem.baseDir);

    return Uri.file(localTarget);
  };
}

export function selectContext(): Promise<Uri | undefined> {
  return new Promise((resolve, reject) => {
    const sercives = getAllFileService();
    const projectsList = sercives
      .map(service => ({
        value: service.baseDir,
        label: service.name || simplifyPath(service.baseDir),
        description: '',
        detail: service.baseDir,
      }))
      .sort((l, r) => l.label.localeCompare(r.label));

    // if (projectsList.length === 1) {
    // return resolve(projectsList[0].value);
    // }

    window
      .showQuickPick(projectsList, {
        placeHolder: 'Select a folder...',
      })
      .then(selection => {
        if (selection) {
          return resolve(Uri.file(selection.value));
        }

        // cancel selection
        resolve();
      }, reject);
  });
}

export function applySelector<T>(...selectors: ((...args: any[]) => T | Promise<T>)[]) {
  return function combinedSelector(...args: any[]): T | Promise<T> {
    let result;
    for (const selector of selectors) {
      result = selector.apply(this, args);
      if (result) {
        break;
      }
    }

    return result;
  };
}

export function uriFromfspath(fileList: string[]): Uri[] | undefined {
  if (!Array.isArray(fileList) || typeof fileList[0] !== 'string') {
    return;
  }

  return fileList.map(file => Uri.file(file));
}

export function getActiveDocumentUri() {
  const active = getActiveTextEditor();
  if (!active || !active.document) {
    return;
  }

  return active.document.uri;
}

export function getActiveFolder() {
  const uri = getActiveDocumentUri();
  if (!uri) {
    return;
  }

  return Uri.file(path.dirname(uri.fsPath));
}

// GitLens (and similarly-built extensions) surface 3rd-party "explorer/context" menu
// commands on their own comparison nodes (e.g. Search & Compare's "N files changed"),
// but invoke them with their own internal tree node object instead of a Uri - there is
// no Uri that represents "all files changed between two refs" to hand over. Recognize
// that node shape by its repoPath/ref1/ref2 fields and resolve the actual changed-file
// list ourselves via the official vscode.git API instead.
async function urisFromGitCompareNode(item): Promise<Uri[] | undefined> {
  if (!item || typeof item.repoPath !== 'string' || typeof item.ref1 !== 'string' || typeof item.ref2 !== 'string') {
    return;
  }

  const repository = getGitService().repositories.find(repo => repo.rootUri.fsPath === item.repoPath);
  if (!repository) {
    return;
  }

  // an empty ref2 is how GitLens represents "the working tree"
  const changes = item.ref2
    ? await repository.diffBetween(item.ref1, item.ref2)
    : (await repository.diffWith(item.ref1)).concat(untrackedChanges(repository));

  const uris: Uri[] = [];
  const skipped: string[] = [];
  for (const change of changes) {
    const reason = skipReason(change);
    if (reason) {
      skipped.push(`  ${simplifyPath(change.uri.fsPath)} (${reason})`);
    } else {
      uris.push(change.uri);
    }
  }

  if (skipped.length) {
    logger.info(`Skipped ${skipped.length} file(s) of the git comparison:\n${skipped.join('\n')}`);
  }

  return uris.length ? uris : undefined;
}

// GitLens includes untracked files in working-tree comparisons, `git diff <ref>` does not
function untrackedChanges(repository: Repository): Change[] {
  const { workingTreeChanges, untrackedChanges = [] } = repository.state;
  return workingTreeChanges.concat(untrackedChanges).filter(change => change.status === Status.UNTRACKED);
}

// Uploads read the local working tree, so a file is uploaded iff it exists on disk; files missing
// locally are skipped, never deleted remotely. The git status is deliberately not consulted: whether
// a change reads as "added" or "deleted" depends on the order the two refs were picked in.
function skipReason(change: Change): string | undefined {
  if (!fs.existsSync(change.uri.fsPath)) {
    return 'not on disk';
  }

  const fileService = getFileService(change.uri);
  if (!fileService) {
    return 'outside of any sftp config';
  }

  const ignore = fileService.getConfig().ignore;
  if (ignore && ignore(change.uri.fsPath)) {
    return 'ignored';
  }
}

// selected file or activeTarget or configContext
export async function uriFromExplorerContextOrEditorContext(item, items): Promise<undefined | Uri | Uri[]> {
  // from explorer or editor context
  if (item instanceof Uri) {
    if (Array.isArray(items) && items[0] instanceof Uri) {
      // multi-select in explorer
      return items;
    } else {
      return item;
    }
  } else if ((item as ExplorerItem).resource) {
    // from remote explorer
    if (Array.isArray(items) && (items[0] as ExplorerItem).resource) {
      // multi-select in remote explorer
      return items.map(_ => _.resource.uri);
    } else {
      return item.resource.uri;
    }
  } else if (Array.isArray(item) && item.length > 0) {
    // some 3rd-party integrations pass the resource list as the sole argument
    // instead of VS Code's own (uri, uris) convention
    if (item[0] instanceof Uri) {
      return item;
    } else if ((item[0] as ExplorerItem).resource) {
      return item.map(_ => _.resource.uri);
    }
  }

  return urisFromGitCompareNode(item);
}

// selected folder or configContext
export function selectFolderFallbackToConfigContext(item, items): Promise<undefined | Uri | Uri[]> {
  // from explorer or editor context
  if (item) {
    if (item instanceof Uri) {
      if (Array.isArray(items) && items[0] instanceof Uri) {
        // multi-select in explorer
        return Promise.resolve(items);
      } else {
        return Promise.resolve(item);
      }
    } else if ((item as ExplorerItem).resource) {
      // from remote explorer
      return Promise.resolve(item.resource.uri);
    } else if (Array.isArray(item) && item.length > 0) {
      // some 3rd-party integrations (e.g. GitLens forwarding "explorer/context" menu
      // commands from a multi-file compare/results node) pass the resource list as
      // the sole argument instead of VS Code's own (uri, uris) convention
      if (item[0] instanceof Uri) {
        return Promise.resolve(item);
      } else if ((item[0] as ExplorerItem).resource) {
        return Promise.resolve(item.map(_ => _.resource.uri));
      }
    }
  }

  return selectContext();
}

// selected file from all remote files
export const selectFileFromAll = createFileSelector();

// selected file from remote files expect ignored
export const selectFile = createFileSelector(configIngoreFilterCreator);
