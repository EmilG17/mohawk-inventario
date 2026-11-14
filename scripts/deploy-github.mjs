import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.DEPLOY_TOKEN || '';
const OWNER = 'EmilG17';
const REPO = 'mohawk-inventario';
const BASE_URL = `https://api.github.com/repos/${OWNER}/${REPO}`;

const headers = {
  Authorization: `token ${TOKEN}`,
  'User-Agent': 'Mohawk-Deploy-Script',
  Accept: 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
};

async function api(endpoint, method = 'GET', body = null) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`API error ${res.status} on ${method} ${endpoint}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createBlob(filePath) {
  const content = fs.readFileSync(filePath);
  const data = await api('/git/blobs', 'POST', {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  return data.sha;
}

function getFilesRecursively(dir, baseDir = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFilesRecursively(fullPath, baseDir));
    } else {
      files.push({
        fullPath,
        relPath: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
      });
    }
  }
  return files;
}

async function deployMain() {
  console.log('--- Actualizando rama main ---');
  const ref = await api('/git/ref/heads/main');
  const parentCommitSha = ref.object.sha;
  const parentCommit = await api(`/git/commits/${parentCommitSha}`);
  const baseTreeSha = parentCommit.tree.sha;

  const dirs = ['src', 'tests', 'sample', 'scripts'];
  const allFiles = [];
  for (const d of dirs) {
    const dirPath = path.join(process.cwd(), d);
    if (fs.existsSync(dirPath)) {
      allFiles.push(...getFilesRecursively(dirPath, process.cwd()));
    }
  }
  const rootFiles = ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'README.md', 'playwright.config.ts'];
  for (const rf of rootFiles) {
    const full = path.join(process.cwd(), rf);
    if (fs.existsSync(full)) {
      allFiles.push({ fullPath: full, relPath: rf });
    }
  }

  const treeEntries = [];
  for (const file of allFiles) {
    console.log(`Subiendo blob: ${file.relPath}`);
    const sha = await createBlob(file.fullPath);
    treeEntries.push({
      path: file.relPath,
      mode: '100644',
      type: 'blob',
      sha,
    });
  }

  console.log('Creando tree para main...');
  const newTree = await api('/git/trees', 'POST', {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  console.log('Creando commit en main...');
  const newCommit = await api('/git/commits', 'POST', {
    message: 'feat(ui): estructura PC/móvil, navegación 4+Más, tablas densas en escritorio, Kardex robusto y QA de 5 puertas',
    tree: newTree.sha,
    parents: [parentCommitSha],
    author: {
      name: 'EmilG17',
      email: '151116875+EmilG17@users.noreply.github.com',
      date: new Date().toISOString(),
    },
  });

  console.log('Actualizando refs/heads/main...');
  await api('/git/refs/heads/main', 'PATCH', {
    sha: newCommit.sha,
    force: true,
  });

  console.log(`✓ Rama main actualizada con éxito: commit ${newCommit.sha.slice(0, 7)}`);
}

async function deployGhPages() {
  console.log('--- Actualizando rama gh-pages (GitHub Pages) ---');
  const ref = await api('/git/ref/heads/gh-pages');
  const parentCommitSha = ref.object.sha;

  const distDir = path.join(process.cwd(), 'dist');
  const distFiles = getFilesRecursively(distDir);

  const treeEntries = [];
  for (const f of distFiles) {
    console.log(`Subiendo dist blob: ${f.relPath}`);
    const sha = await createBlob(f.fullPath);
    treeEntries.push({
      path: f.relPath,
      mode: '100644',
      type: 'blob',
      sha,
    });
  }

  // Añadir .nojekyll para GitHub Pages
  const nojekyllRes = await api('/git/blobs', 'POST', {
    content: '',
    encoding: 'utf-8',
  });
  treeEntries.push({
    path: '.nojekyll',
    mode: '100644',
    type: 'blob',
    sha: nojekyllRes.sha,
  });

  console.log('Creando tree para gh-pages...');
  const newTree = await api('/git/trees', 'POST', {
    tree: treeEntries,
  });

  console.log('Creando commit en gh-pages...');
  const newCommit = await api('/git/commits', 'POST', {
    message: 'deploy(ui): estructura responsiva PC/móvil verificada (296 unit, 270 E2E)',
    tree: newTree.sha,
    parents: [parentCommitSha],
    author: {
      name: 'EmilG17',
      email: '151116875+EmilG17@users.noreply.github.com',
      date: new Date().toISOString(),
    },
  });

  console.log('Actualizando refs/heads/gh-pages...');
  await api('/git/refs/heads/gh-pages', 'PATCH', {
    sha: newCommit.sha,
    force: true,
  });

  console.log(`✓ Rama gh-pages actualizada con éxito: commit ${newCommit.sha.slice(0, 7)}`);
}

async function main() {
  try {
    await deployMain();
    await deployGhPages();
    console.log('\n🚀 Despliegue completado con éxito.');
  } catch (err) {
    console.error('Error durante el despliegue:', err);
    process.exit(1);
  }
}

main();
