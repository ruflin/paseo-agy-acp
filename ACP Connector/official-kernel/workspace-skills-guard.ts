import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The stock 1.4.3 kernel materialises its built-in skills (currently
 * `skills/system/run-workflow/SKILL.md`) inside the session workspace because
 * its default `SkillsConfig.presentation_mode` is FILE_SYSTEM. The managed
 * Linux x86_64 compatibility wrapper patches that mode to TOOL; the signed
 * macOS and Windows archives cannot be patched, so the write still happens
 * there.
 *
 * This guard keeps those generated files out of the checkout: it points
 * `<cwd>/skills` (or `<cwd>/skills/system` when the checkout already owns a
 * real `skills/` directory) at a session-scoped directory under the user's
 * state directory, and removes the link again when the connector exits.
 * User-authored skills are never moved or replaced.
 */
export interface WorkspaceSkillsGuardOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly stateRoot?: string;
  readonly log?: (message: string) => void;
}

export const WORKSPACE_SKILLS_GUARD_ENV = "PASEO_AGY_ACP_WORKSPACE_SKILLS_GUARD";

const SHADOW_ROOT_DIRECTORY = "workspace-skills";

interface GuardEntry {
  readonly linkPath: string;
  readonly shadowPath: string;
}

export class WorkspaceSkillsGuard {
  readonly #enabled: boolean;
  readonly #stateRoot: string;
  readonly #log: (message: string) => void;
  readonly #entries = new Map<string, GuardEntry>();
  #disposed = false;

  constructor(options: WorkspaceSkillsGuardOptions = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const mode = (env[WORKSPACE_SKILLS_GUARD_ENV] ?? "").trim().toLowerCase();
    // Stock kernels write workspace skills on every platform except the
    // patched Linux x86_64 build. Default to the affected macOS desktops and
    // allow `redirect` for other POSIX hosts or `off` as an escape hatch.
    this.#enabled =
      mode === "off" || mode === "0" || mode === "false"
        ? false
        : mode === "redirect"
          ? platform !== "win32"
          : platform === "darwin";
    const home = env.HOME?.trim() || homedir();
    this.#stateRoot = path.resolve(
      options.stateRoot ?? path.join(home, ".local", "state", "paseo-agy-acp", SHADOW_ROOT_DIRECTORY)
    );
    this.#log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Best effort: never block a session because a workspace cannot be guarded. */
  arm(cwd: string | undefined): void {
    if (!this.#enabled || this.#disposed || typeof cwd !== "string" || cwd.trim().length === 0) return;
    const workspace = path.resolve(cwd);
    const workspaceInfo = lstatOrUndefined(workspace);
    if (workspaceInfo === undefined || !workspaceInfo.isDirectory()) return;
    const skillsPath = path.join(workspace, "skills");
    if (this.#entries.has(skillsPath)) return;
    const shadowRoot = this.#shadowRootFor(skillsPath);
    try {
      const existingSkills = lstatOrUndefined(skillsPath);
      if (existingSkills?.isSymbolicLink() === true && this.#ownsLink(skillsPath)) {
        // A previous connector in this workspace left its redirect behind.
        this.#entries.set(skillsPath, { linkPath: skillsPath, shadowPath: shadowRoot });
        return;
      }
      if (existingSkills !== undefined && !existingSkills.isDirectory()) {
        // A regular file, or a symlink this guard does not own. Leave it alone.
        return;
      }
      const systemPath = path.join(skillsPath, "system");
      const existingSystem = lstatOrUndefined(systemPath);
      if (existingSystem !== undefined) {
        if (existingSystem.isSymbolicLink() && this.#ownsLink(systemPath)) {
          this.#entries.set(skillsPath, {
            linkPath: systemPath,
            shadowPath: path.join(shadowRoot, "system")
          });
        }
        return;
      }
      mkdirSync(path.join(shadowRoot, "system"), { recursive: true, mode: 0o700 });
      if (existingSkills === undefined) {
        symlinkSync(shadowRoot, skillsPath, "dir");
        this.#entries.set(skillsPath, { linkPath: skillsPath, shadowPath: shadowRoot });
      } else {
        symlinkSync(path.join(shadowRoot, "system"), systemPath, "dir");
        this.#entries.set(skillsPath, {
          linkPath: systemPath,
          shadowPath: path.join(shadowRoot, "system")
        });
      }
      this.#log(
        `paseo-agy-acp redirected generated workspace skills outside the checkout: ${skillsPath} -> ${path.relative(path.dirname(skillsPath), shadowRoot)} (set ${WORKSPACE_SKILLS_GUARD_ENV}=off to disable)`
      );
    } catch (error) {
      this.#log(
        `paseo-agy-acp could not redirect generated workspace skills for ${skillsPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Removes only redirect links this instance created (or inherited). */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      try {
        const info = lstatOrUndefined(entry.linkPath);
        if (info?.isSymbolicLink() === true && this.#ownsLink(entry.linkPath)) {
          unlinkSync(entry.linkPath);
        }
      } catch {
        // The link was already removed or replaced; never fail shutdown.
      }
      try {
        rmSync(entry.shadowPath, { recursive: true, force: true });
      } catch {
        // Generated data only; a leftover directory is not worth failing on.
      }
    }
    this.#entries.clear();
  }

  #shadowRootFor(skillsPath: string): string {
    const workspace = path.dirname(skillsPath);
    const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 32);
    return path.join(this.#stateRoot, digest);
  }

  #ownsLink(linkPath: string): boolean {
    try {
      const info = lstatSync(linkPath);
      if (!info.isSymbolicLink()) return false;
      const target = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
      return isPathInside(this.#stateRoot, target);
    } catch {
      return false;
    }
  }
}

function lstatOrUndefined(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
