/* GitHub REST access for a (private) monorepo of KiCad projects. Uses a fine-grained
 * personal access token with read-only Contents permission. Blobs are cached by SHA. */
(function (root) {
  'use strict';
  const API = 'https://api.github.com';

  class GitHubError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  function explain(status, body, what) {
    const msg = body && body.message ? body.message : '';
    if (status === 401) return 'GitHub rejected the token. It may have expired or been revoked; create a new one and paste it in.';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub API rate limit reached. Try again in a few minutes.';
    if (status === 403 && /SAML|SSO/i.test(msg)) return 'Your organisation requires SSO authorisation for this token. Authorise it on GitHub (Settings → Developer settings → Tokens) and try again.';
    if (status === 403 && /resource not accessible|forbidden/i.test(msg)) return 'The token does not have access to ' + what + '. Give it Contents: Read-only on this repository, or ask an org owner to approve it.';
    if (status === 404) return 'Could not find ' + what + '. Check the owner/repository name, and that the token has been granted access to it.';
    return 'GitHub error ' + status + (msg ? ': ' + msg : '') + '.';
  }

  async function api(token, path, what, accept, init) {
    let res;
    try {
      const headers = Object.assign({ Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, token ? { Authorization: 'Bearer ' + token } : {});
      if (init && init.body) headers['Content-Type'] = 'application/json';
      res = await fetch(API + path, Object.assign({ headers, cache: 'no-store' }, init || {}));
    } catch (e) {
      throw new GitHubError('Could not reach GitHub. Check your connection; cached schematics still open offline.', 0);
    }
    if (!res.ok) {
      let body = null; try { body = await res.json(); } catch (e) { /* ignore */ }
      const err = new GitHubError(init && init.method && init.method !== 'GET' && (res.status === 403 || res.status === 404)
        ? 'GitHub refused to save. The token needs write access to this repository (a classic token with the repo scope, or a fine-grained token with Contents: Read and write and Pull requests: Read and write).'
        : explain(res.status, body, what || 'that resource'), res.status);
      err.body = body;
      throw err;
    }
    return res;
  }
  const json = async (token, path, what) => (await api(token, path, what)).json();
  const send = async (token, method, path, body, what) => (await api(token, path, what, null, { method, body: JSON.stringify(body) })).json();
  const enc = (s) => s.split('/').map(encodeURIComponent).join('/');

  const GitHub = {
    GitHubError,
    async repo(token, full) {
      return json(token, '/repos/' + enc(full), 'the repository ' + full);
    },
    async branches(token, full) {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const b = await json(token, `/repos/${enc(full)}/branches?per_page=100&page=${page}`, 'branches');
        out.push(...b.map((x) => x.name));
        if (b.length < 100) break;
      }
      return out;
    },
    async tags(token, full) {
      try { return (await json(token, `/repos/${enc(full)}/tags?per_page=50`, 'tags')).map((x) => x.name); } catch (e) { return []; }
    },
    /** Head commit of a branch/tag/sha: {sha, tree, message, date, author} */
    async head(token, full, ref) {
      const c = await json(token, `/repos/${enc(full)}/commits/${encodeURIComponent(ref)}`, 'the branch ' + ref);
      return { sha: c.sha, tree: c.commit.tree.sha, message: c.commit.message, date: c.commit.committer.date || c.commit.author.date, author: (c.author && c.author.login) || c.commit.author.name };
    },
    /** Recursive tree, filtered to KiCad files: [{path, sha, size}] */
    async kicadTree(token, full, treeSha) {
      const cached = await Store.get('tree:' + treeSha);
      if (cached) return cached;
      const t = await json(token, `/repos/${enc(full)}/git/trees/${treeSha}?recursive=1`, 'the file list');
      const files = t.tree
        .filter((e) => e.type === 'blob' && /\.(kicad_sch|kicad_pro)$/i.test(e.path))
        .filter((e) => !/(^|\/)(_autosave-|#auto_saved_files#|~)|-backups\//.test(e.path))
        .map((e) => ({ path: e.path, sha: e.sha, size: e.size }));
      const out = { files, truncated: !!t.truncated };
      await Store.set('tree:' + treeSha, out);
      return out;
    },
    async blobText(token, full, sha) {
      const key = 'blob:' + sha;
      const cached = await Store.get(key);
      if (typeof cached === 'string') return cached;
      const b = await json(token, `/repos/${enc(full)}/git/blobs/${sha}`, 'a schematic file');
      let text;
      if (b.encoding === 'base64') {
        const bin = atob(b.content.replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder().decode(bytes);
      } else text = b.content;
      if (/^version https:\/\/git-lfs/.test(text)) throw new GitHubError('This file is stored in Git LFS, which the viewer cannot read yet.', 415);
      await Store.set(key, text);
      return text;
    },
    /**
     * Commit changed files to a branch (created from parentSha if it doesn't exist yet).
     * files: [{path, text}]. Returns {sha, tree, created}.
     */
    async commitFiles(token, full, opts) {
      const { branch, parentSha, message, files } = opts;
      let parent = parentSha, baseTree = opts.baseTree, exists = false;
      try {
        const ref = await json(token, `/repos/${enc(full)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, 'the branch ' + branch);
        parent = ref.object.sha; exists = true;
        const c = await json(token, `/repos/${enc(full)}/git/commits/${parent}`, 'the branch head');
        baseTree = c.tree.sha;
      } catch (e) { if (e.status && e.status !== 404) throw e; }
      if (!baseTree) { const c = await json(token, `/repos/${enc(full)}/git/commits/${parent}`, 'the base commit'); baseTree = c.tree.sha; }
      const tree = await send(token, 'POST', `/repos/${enc(full)}/git/trees`, { base_tree: baseTree, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })) }, 'the new file tree');
      const commit = await send(token, 'POST', `/repos/${enc(full)}/git/commits`, { message, tree: tree.sha, parents: [parent] }, 'the commit');
      if (exists) await send(token, 'PATCH', `/repos/${enc(full)}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { sha: commit.sha, force: false }, 'the branch');
      else await send(token, 'POST', `/repos/${enc(full)}/git/refs`, { ref: 'refs/heads/' + branch, sha: commit.sha }, 'the branch');
      return { sha: commit.sha, tree: tree.sha, created: !exists, message, date: new Date().toISOString() };
    },
    /** Open a pull request for branch → base, or return the one already open. */
    async ensurePullRequest(token, full, opts) {
      const owner = full.split('/')[0];
      const open = await json(token, `/repos/${enc(full)}/pulls?state=open&head=${encodeURIComponent(owner + ':' + opts.branch)}`, 'pull requests');
      if (open.length) return { number: open[0].number, url: open[0].html_url, existed: true };
      const pr = await send(token, 'POST', `/repos/${enc(full)}/pulls`, { title: opts.title, head: opts.branch, base: opts.base, body: opts.body || '' }, 'the pull request');
      return { number: pr.number, url: pr.html_url, existed: false };
    },
    async user(token) {
      return json(token, '/user', 'your GitHub account');
    },
    /** A small text file on a branch: {text, sha} or null if the branch or file doesn't exist. */
    async readFile(token, full, branch, path) {
      try {
        const f = await json(token, `/repos/${enc(full)}/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`, path);
        const bin = atob((f.content || '').replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { text: new TextDecoder().decode(bytes), sha: f.sha };
      } catch (e) { if (e.status === 404) return null; throw e; }
    },
    /** Write one file on a branch. Creates the branch with no history (an orphan) if it doesn't exist. Returns the new blob sha. */
    async writeFile(token, full, branch, path, text, sha, message) {
      const bytes = new TextEncoder().encode(text);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const body = { message, content: btoa(bin), branch };
      if (sha) body.sha = sha;
      try {
        const r = await send(token, 'PUT', `/repos/${enc(full)}/contents/${enc(path)}`, body, path);
        return r.content.sha;
      } catch (e) {
        if (sha || (e.status !== 404 && e.status !== 422)) throw e;
        let exists = true;
        try { await json(token, `/repos/${enc(full)}/git/ref/heads/${enc(branch)}`, 'the branch ' + branch); } catch (e2) { if (e2.status === 404) exists = false; else throw e2; }
        if (exists) throw e;
        const tree = await send(token, 'POST', `/repos/${enc(full)}/git/trees`, { tree: [{ path, mode: '100644', type: 'blob', content: text }] }, 'the new file tree');
        const commit = await send(token, 'POST', `/repos/${enc(full)}/git/commits`, { message, tree: tree.sha, parents: [] }, 'the commit');
        await send(token, 'POST', `/repos/${enc(full)}/git/refs`, { ref: 'refs/heads/' + branch, sha: commit.sha }, 'the branch');
        return gitBlobSha(text);
      }
    },
    async history(token, full, ref, path, n) {
      const q = `/repos/${enc(full)}/commits?sha=${encodeURIComponent(ref)}&per_page=${n || 20}` + (path ? '&path=' + encodeURIComponent(path) : '');
      const list = await json(token, q, 'the commit history');
      return list.map((c) => ({ sha: c.sha, tree: c.commit.tree.sha, message: c.commit.message, date: c.commit.committer.date || c.commit.author.date, author: (c.author && c.author.login) || c.commit.author.name }));
    }
  };

  /** Groups KiCad files into projects: one per .kicad_pro, plus loose folders of schematics. */
  function groupProjects(files) {
    const pros = files.filter((f) => /\.kicad_pro$/i.test(f.path)).map((f) => f.path);
    const dir = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
    const proDirs = pros.map(dir);
    const owner = (p) => {
      // deepest project dir that contains this file
      let best = null;
      proDirs.forEach((d, i) => { if ((d === '' || p.startsWith(d + '/')) && (best === null || d.length > proDirs[best].length)) best = i; });
      return best;
    };
    const projects = pros.map((p, i) => ({ key: p, dir: proDirs[i], name: p.slice(p.lastIndexOf('/') + 1).replace(/\.kicad_pro$/i, ''), files: [files.find((f) => f.path === p)] }));
    const loose = new Map();
    for (const f of files) {
      if (!/\.kicad_sch$/i.test(f.path)) continue;
      const o = owner(f.path);
      if (o !== null) projects[o].files.push(f);
      else {
        const d = dir(f.path);
        if (!loose.has(d)) loose.set(d, { key: d + '/', dir: d, name: d ? d.slice(d.lastIndexOf('/') + 1) : '(repository root)', files: [], loose: true });
        loose.get(d).files.push(f);
      }
    }
    const all = projects.filter((p) => p.files.some((f) => /\.kicad_sch$/i.test(f.path))).concat(Array.from(loose.values()));
    // Two projects can share a folder (e.g. a v1 and v2); keep only schematics the root references later.
    all.sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }) || a.name.localeCompare(b.name));
    return all;
  }

  /** Git's blob id for a text, so files we just committed can be cached for offline use. */
  async function gitBlobSha(text) {
    const bytes = new TextEncoder().encode(text);
    const head = new TextEncoder().encode('blob ' + bytes.length + '\0');
    const all = new Uint8Array(head.length + bytes.length); all.set(head); all.set(bytes, head.length);
    const h = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  GitHub.gitBlobSha = gitBlobSha;
  root.GitHub = GitHub;
  root.groupProjects = groupProjects;
})(typeof globalThis !== 'undefined' ? globalThis : this);
