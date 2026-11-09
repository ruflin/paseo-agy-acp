import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSkillsGuard, WORKSPACE_SKILLS_GUARD_ENV } from "../ACP Connector/official-kernel/workspace-skills-guard.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function createGuard(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}) {
  const stateRoot = path.join(tempDir("agy-skills-guard-state-"), "workspace-skills");
  const messages: string[] = [];
  return {
    stateRoot,
    messages,
    guard: new WorkspaceSkillsGuard({
      platform: options.platform ?? "darwin",
      env: { HOME: os.homedir(), ...options.env },
      stateRoot,
      log: (message) => messages.push(message)
    })
  };
}

function writeGeneratedSkill(root: string): string {
  const skillDirectory = path.join(root, "skills", "system", "run-workflow");
  mkdirSync(skillDirectory, { recursive: true });
  const file = path.join(skillDirectory, "SKILL.md");
  writeFileSync(file, "# generated\n");
  return file;
}

describe("WorkspaceSkillsGuard", () => {
  it("redirects the generated skills tree outside the checkout and removes it on dispose", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const { guard, stateRoot, messages } = createGuard();

    guard.arm(workspace);

    const skillsPath = path.join(workspace, "skills");
    expect(lstatSync(skillsPath).isSymbolicLink()).toBe(true);
    const linkTarget = path.resolve(path.dirname(skillsPath), readlinkSync(skillsPath));
    expect(linkTarget.startsWith(path.resolve(stateRoot))).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("redirected generated workspace skills");
    expect(messages[0]).toContain(WORKSPACE_SKILLS_GUARD_ENV);

    const generated = writeGeneratedSkill(workspace);
    expect(existsSync(generated)).toBe(true);
    expect(realpathSync(generated).startsWith(realpathSync(stateRoot))).toBe(true);

    guard.dispose();

    expect(existsSync(skillsPath)).toBe(false);
    expect(existsSync(path.dirname(generated))).toBe(false);
  });

  it("keeps a checkout-owned skills directory and only redirects the system namespace", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const owned = path.join(workspace, "skills", "paseo", "SKILL.md");
    mkdirSync(path.dirname(owned), { recursive: true });
    writeFileSync(owned, "# owned\n");
    const { guard } = createGuard();

    guard.arm(workspace);

    const systemPath = path.join(workspace, "skills", "system");
    expect(lstatSync(systemPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(owned, "utf8")).toBe("# owned\n");

    writeGeneratedSkill(workspace);
    guard.dispose();

    expect(existsSync(systemPath)).toBe(false);
    expect(readFileSync(owned, "utf8")).toBe("# owned\n");
  });

  it("never replaces an existing generated or user-owned skills/system directory", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const systemPath = path.join(workspace, "skills", "system");
    mkdirSync(systemPath, { recursive: true });
    writeFileSync(path.join(systemPath, "keep.txt"), "keep\n");
    const { guard, messages } = createGuard();

    guard.arm(workspace);
    guard.dispose();

    expect(lstatSync(systemPath).isDirectory()).toBe(true);
    expect(readFileSync(path.join(systemPath, "keep.txt"), "utf8")).toBe("keep\n");
    expect(messages).toHaveLength(0);
  });

  it("leaves a foreign skills symlink alone", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const shared = tempDir("agy-skills-shared-");
    symlinkSync(shared, path.join(workspace, "skills"), "dir");
    const { guard } = createGuard();

    guard.arm(workspace);
    guard.dispose();

    expect(lstatSync(path.join(workspace, "skills")).isSymbolicLink()).toBe(true);
  });

  it("is idempotent for repeated sessions in the same workspace", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const { guard } = createGuard();

    guard.arm(workspace);
    guard.arm(workspace);

    expect(lstatSync(path.join(workspace, "skills")).isSymbolicLink()).toBe(true);
    guard.dispose();
    expect(existsSync(path.join(workspace, "skills"))).toBe(false);
  });

  it("removes an inherited redirect from an earlier crashed connector", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const first = createGuard();
    first.guard.arm(workspace);
    // Simulate a crash: no dispose call, then a new connector starts with the
    // same state root and adopts the link.
    const inherited = new WorkspaceSkillsGuard({
      platform: "darwin",
      env: { HOME: os.homedir() },
      stateRoot: first.stateRoot,
      log: () => undefined
    });
    inherited.arm(workspace);
    inherited.dispose();

    expect(existsSync(path.join(workspace, "skills"))).toBe(false);
  });

  it("is disabled by default off macOS and can be disabled explicitly", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const linux = createGuard({ platform: "linux" });
    linux.guard.arm(workspace);
    expect(existsSync(path.join(workspace, "skills"))).toBe(false);

    const disabled = createGuard({ env: { [WORKSPACE_SKILLS_GUARD_ENV]: "off" } });
    disabled.guard.arm(workspace);
    expect(existsSync(path.join(workspace, "skills"))).toBe(false);
  });

  it("can be forced on non-Windows hosts with redirect", () => {
    const workspace = tempDir("agy-skills-workspace-");
    const { guard } = createGuard({ platform: "linux", env: { [WORKSPACE_SKILLS_GUARD_ENV]: "redirect" } });

    guard.arm(workspace);

    expect(lstatSync(path.join(workspace, "skills")).isSymbolicLink()).toBe(true);
    guard.dispose();
  });

  it("ignores empty and missing workspaces", () => {
    const { guard, messages } = createGuard();

    guard.arm(undefined);
    guard.arm("");
    guard.arm(path.join(tempDir("agy-skills-missing-"), "does-not-exist"));

    expect(messages).toHaveLength(0);
  });
});
