import { describe, expect, test } from 'claude-code/testing'

import { judge, settingsOf, TEMP_DIRS } from '../hooks/policy'
import { findWrites, jsWrites, parseShell, pythonWrites, resolvePath } from '../hooks/shell'

const paths = (command: string, cwd = '/w') => findWrites(command, { cwd, home: '/home/u' }).map(w => w.path)
const vias = (command: string) => findWrites(command, { cwd: '/w', home: '/home/u' }).map(w => `${w.via}:${w.path}`)

describe('redirections of text the model wrote', () => {
  test('cat > file <<EOF (quoted and plain delimiters)', () => {
    expect(paths("cat > a.txt <<'EOF'\nhello $HOME\nEOF")).toEqual(['/w/a.txt'])
    expect(paths('cat <<EOF > b.txt\nplain text\nEOF')).toEqual(['/w/b.txt'])
    expect(paths('cat >> notes.md << "END"\nmore\nEND')).toEqual(['/w/notes.md'])
  })

  test('an unquoted here-document that expands at run time is generated content, not an edit', () => {
    expect(paths('cat <<EOF > a.sh\necho $HOME\nEOF')).toEqual([])
    expect(paths('cat > stamp.txt <<EOF\nbuilt $(date)\nEOF')).toEqual([])
  })

  test('echo, printf, : and a bare redirection', () => {
    expect(paths('echo hi >> .gitignore')).toEqual(['/w/.gitignore'])
    expect(paths("printf '%s\\n' a b > list.txt")).toEqual(['/w/list.txt'])
    expect(paths('> empty.txt')).toEqual(['/w/empty.txt'])
    expect(paths(': > truncated.txt')).toEqual(['/w/truncated.txt'])
    expect(paths("echo $'a\\nb' > f")).toEqual(['/w/f'])
  })

  test('values only known at run time are not something Edit could write', () => {
    expect(paths('echo "$(date)" >> notes.md')).toEqual([])
    expect(paths('printf "%s" "$NEWPASS" > pw.txt')).toEqual([])
    expect(paths('echo `whoami` > who.txt')).toEqual([])
    expect(paths('X=1; echo "a=$X" >> .env'), 'a value set in the same command is known').toEqual(['/w/.env'])
  })

  test('stderr and descriptor redirections are not writes of content', () => {
    expect(paths('echo x 2> err.txt')).toEqual([])
    expect(paths('echo x 2>&1')).toEqual([])
    expect(paths('echo x >&2')).toEqual([])
    expect(paths('echo x > /dev/null 2>&1')).toEqual(['/dev/null'])
  })

  test("another program's output is generated, never refused: git, npm, curl, a copy", () => {
    expect(paths('git diff > x.patch')).toEqual([])
    expect(paths('npm test > test-output.txt 2>&1')).toEqual([])
    expect(paths('curl -s https://example.com > page.html')).toEqual([])
    expect(paths('cat src.txt > copy.txt')).toEqual([])
    expect(paths('ssh host cat /etc/x > local-copy.txt')).toEqual([])
    expect(paths('curl -s x | cat > out.txt'), 'cat passing on a download').toEqual([])
  })

  test('groups: authored only when every command in them prints literal text', () => {
    expect(paths('{ echo a; echo b; } > out.txt')).toEqual(['/w/out.txt'])
    expect(paths('{ date; echo b; } > info.txt')).toEqual([])
    expect(paths('(echo a; printf b) >> out.txt')).toEqual(['/w/out.txt'])
  })

  test('tee writes what it is fed: literal text yes, program output no', () => {
    expect(paths("cat <<'EOF' | sudo tee -a /etc/hosts > /dev/null\n1.2.3.4 x\nEOF")).toEqual(['/etc/hosts', '/dev/null'])
    expect(paths('echo x | tee a b')).toEqual(['/w/a', '/w/b'])
    expect(paths("tee conf.ini <<'EOF'\n[a]\nEOF")).toEqual(['/w/conf.ini'])
    expect(paths('npm run build 2>&1 | tee build-output.txt')).toEqual([])
  })

  test('here-strings', () => {
    expect(paths("cat <<< 'text' > f")).toEqual(['/w/f'])
    expect(paths('cat <<< "$X" > f')).toEqual([])
  })
})

describe('quoting', () => {
  test('operators inside quotes are text', () => {
    expect(paths("echo 'a > b' && echo \"c >> d\"")).toEqual([])
    expect(paths("grep -c '>' f")).toEqual([])
    expect(paths('echo \\> notafile')).toEqual([])
  })

  test('quoted and joined file names', () => {
    expect(paths('echo a > "my file.txt"')).toEqual(['/w/my file.txt'])
    expect(paths("echo a > 'x'\"y\"z")).toEqual(['/w/xyz'])
  })

  test('comparisons in [[ ]] and arithmetic are no redirections', () => {
    expect(paths('[[ 2 > 1 ]] && echo ok')).toEqual([])
    expect(paths('(( a > 3 )) && echo ok')).toEqual([])
    expect(paths('echo $(( 2 > 1 ))')).toEqual([])
    expect(paths('echo "$(echo $((1 + 2)))" && echo a > after.txt'), 'arithmetic inside a substitution').toEqual(['/w/after.txt'])
  })

  test('comments', () => {
    expect(paths('ls # then echo a > f')).toEqual([])
    expect(paths('echo a#b > f')).toEqual(['/w/f'])
  })
})

describe('sed -i and perl -i', () => {
  test('every target file, with -e and several files', () => {
    expect(paths("sed -i 's/a/b/' f.txt")).toEqual(['/w/f.txt'])
    expect(paths("sed -i -e 's/a/b/' -e 's/c/d/' a.ts b.ts src/c.ts")).toEqual(['/w/a.ts', '/w/b.ts', '/w/src/c.ts'])
    expect(paths("sed -i -f fix.sed a.ts")).toEqual(['/w/a.ts'])
  })

  test('suffixes and spellings: -i.bak, --in-place, -Ei, BSD -i ""', () => {
    expect(paths("sed -i.bak 's/a/b/' f")).toEqual(['/w/f'])
    expect(paths("sed --in-place=.orig 's/a/b/' f")).toEqual(['/w/f'])
    expect(paths("sed --in-place --expression='s/a/b/' f")).toEqual(['/w/f'])
    expect(paths("sed -Ei 's/a+/b/' f")).toEqual(['/w/f'])
    expect(paths("sed -ri 's/a+/b/' f")).toEqual(['/w/f'])
    expect(paths("sed -i '' 's/a/b/' mac.txt")).toEqual(['/w/mac.txt'])
    expect(paths("sed -i .bak 's/a/b/' mac.txt")).toEqual(['/w/mac.txt'])
  })

  test('no -i, no write', () => {
    expect(paths("sed -n 's/a/b/p' f")).toEqual([])
    expect(paths("sed 's/a/b/' f")).toEqual([])
    expect(paths("sed -n 1,20p file.ts | head")).toEqual([])
  })

  test('sudo, env, timeout, nice and xargs in front', () => {
    expect(paths("sudo sed -i 's/a/b/' /etc/app.conf")).toEqual(['/etc/app.conf'])
    expect(paths("sudo -u www sed -i 's/a/b/' conf")).toEqual(['/w/conf'])
    expect(paths("env LC_ALL=C sed -i 's/a/b/' f")).toEqual(['/w/f'])
    expect(paths("timeout 10 nice -n 5 sed -i 's/a/b/' f")).toEqual(['/w/f'])
    expect(paths("grep -rl old . | xargs sed -i 's/old/new/g'")).toEqual(['/w/**'])
    expect(paths("git ls-files -z | xargs -0 -I{} sed -i 's/a/b/' {}")).toEqual(['/w/**'])
  })

  test('&& chains, cd and subshells', () => {
    expect(paths("cd sub && sed -i 's/a/b/' f")).toEqual(['/w/sub/f'])
    expect(paths("(cd sub && sed -i 's/a/b/' f) && sed -i 's/a/b/' g")).toEqual(['/w/sub/f', '/w/g'])
    expect(paths("cd /etc; sed -i 's/a/b/' hosts", '/w')).toEqual(['/etc/hosts'])
    expect(paths("npm test && sed -i 's/a/b/' f || echo failed")).toEqual(['/w/f'])
  })

  test('loops and find -exec name the files they reach', () => {
    expect(paths("for f in src/*.ts; do sed -i 's/a/b/' \"$f\"; done")).toEqual(['/w/src/*.ts'])
    expect(paths("find src -name '*.ts' -exec sed -i 's/a/b/' {} +")).toEqual(['/w/src/**'])
    expect(paths("find . -name '*.md' -exec perl -pi -e 's/a/b/' {} \\;")).toEqual(['/w/**'])
  })

  test('a target only known at run time is reported without a path', () => {
    const w = findWrites("sed -i 's/x/y/' $(git ls-files)", { cwd: '/w' })
    expect(w.map(x => x.path)).toEqual([null])
  })

  test('perl -i', () => {
    expect(paths("perl -pi -e 's/a/b/' f")).toEqual(['/w/f'])
    expect(paths("perl -i.bak -pe 's/a/b/' f g")).toEqual(['/w/f', '/w/g'])
    expect(paths("perl -0777 -i -pe 's/a/b/s' f")).toEqual(['/w/f'])
    expect(paths("perl -ne 'print if /x/' f")).toEqual([])
  })

  test('edit through a temporary file: the moved-over file is the one changed', () => {
    expect(vias("sed 's/a/b/' f > f.tmp && mv f.tmp f")).toEqual(['mv:/w/f'])
    expect(vias("jq '.version=\"2\"' package.json > /tmp/p.json && mv /tmp/p.json package.json")).toEqual(['mv:/w/package.json'])
    expect(paths('git show HEAD:a.ts > /tmp/a.ts && cp /tmp/a.ts a.ts'), 'a restore from git is not an edit').toEqual([])
  })

  test('a file written and removed in the same command was scratch', () => {
    expect(paths("echo x > probe.txt && cat probe.txt && rm -f probe.txt")).toEqual([])
    expect(paths("mkdir t && echo x > t/a.txt && sh t/a.txt; rm -rf t")).toEqual([])
    expect(paths("cp /tmp/t.ts t.test.ts && sed -i 's/a/b/' t.test.ts && npx vitest t.test.ts; rm -f t.test.ts")).toEqual([])
  })
})

describe('here-document delimiters', () => {
  test('<<- strips leading tabs, the delimiter included', () => {
    expect(paths("cat <<-EOF > a.txt\n\tindented\n\tEOF\necho done > b.txt")).toEqual(['/w/a.txt', '/w/b.txt'])
  })

  test('only an exact delimiter line ends the body', () => {
    // `EOF ` and `EOFX` are body lines: the `> c.txt` below them is text, not a redirection.
    expect(paths("cat <<'EOF' > a.txt\nEOF \nEOFX\necho x > c.txt\nEOF\necho y > d.txt")).toEqual(['/w/a.txt', '/w/d.txt'])
  })

  test('two here-documents on one line are read in order', () => {
    expect(paths('cat <<A > a.txt; cat <<B > b.txt\none\nA\ntwo\nB')).toEqual(['/w/a.txt', '/w/b.txt'])
  })

  test('a commit message with a parenthesis inside $(cat <<EOF) is no write', () => {
    expect(paths("git commit -m \"$(cat <<'EOF'\nfix: guard (finally)\n\n> quoted line\nEOF\n)\"")).toEqual([])
  })

  test('a body is data: redirections inside it are not run', () => {
    expect(paths("cat <<'EOF' | ssh host 'cat > /etc/x'\necho a > b\nEOF")).toEqual([])
    expect(paths("git commit -F - <<'EOF'\necho a > b\nEOF")).toEqual([])
  })

  test('a body that never ends is read to the end', () => {
    expect(paths("cat > a.txt <<'EOF'\nno end")).toEqual(['/w/a.txt'])
  })
})

describe('scripts', () => {
  test('a Python heredoc that reads and rewrites a file', () => {
    const cmd = "python3 - <<'EOF'\np = 'src/app.ts'\ns = open(p).read()\nopen(p, 'w').write(s.replace('a', 'b'))\nEOF"
    expect(vias(cmd)).toEqual(['script:/w/src/app.ts'])
  })

  test('several files in one script, one line each, names reused', () => {
    const code = "p='a.js'; s=open(p).read()\nopen(p,'w').write(s)\nt='b.test.js'; s=open(t).read(); open(t,'w').write(s)\np='c.ts'; s=open(p).read()\nopen(p,'w').write(s)"
    expect(pythonWrites(code).map(w => w.path)).toEqual(['a.js', 'b.test.js', 'c.ts'])
  })

  test('literal text written to a new file counts; computed data does not', () => {
    expect(paths("python3 -c \"open('new.md','w').write('# Title')\"")).toEqual(['/w/new.md'])
    expect(paths("python3 - <<'EOF'\nimport json\nrows = compute()\njson.dump(rows, open('report.json', 'w'))\nEOF")).toEqual([])
    expect(paths("python3 - <<'EOF'\nfrom pathlib import Path\nPath('docs/a.md').write_text('''# A\n''')\nEOF")).toEqual(['/w/docs/a.md'])
    expect(paths("python3 - <<'EOF'\nwith open('n.txt', 'w') as f:\n    f.write(\"\"\"line\"\"\")\nEOF")).toEqual(['/w/n.txt'])
  })

  test('a JSON config loaded and dumped back is an edit', () => {
    const cmd = "python3 - <<'EOF'\nimport json\np = 'package.json'\nd = json.load(open(p))\nd['x'] = 1\njson.dump(d, open(p, 'w'), indent=2)\nEOF"
    expect(paths(cmd)).toEqual(['/w/package.json'])
  })

  test('a helper that edits, called per file; a loop over a list', () => {
    const helper = "def edit(p, pairs):\n    s=open(p).read()\n    for a,b in pairs: s=s.replace(a,b)\n    open(p,'w').write(s)\nedit('a.tsx', [('x','y')])\nM='b.js'\nedit(M, [])"
    expect(pythonWrites(helper).map(w => w.path)).toEqual(['a.tsx', 'b.js'])
    const loop = "for p in ['x.md', 'y.md']:\n    s=open(p).read()\n    open(p, 'w').write(s)"
    expect(pythonWrites(loop).map(w => w.path)).toEqual(['x.md', 'y.md'])
    const pairs = "for p,var in [('d.tsx','items'),('s.tsx','topics')]:\n    s=open(p).read()\n    open(p,'w').write(s)"
    expect(pythonWrites(pairs).map(w => w.path)).toEqual(['d.tsx', 's.tsx'])
  })

  test('paths built with os.path.join, Path / and sys.argv', () => {
    expect(pythonWrites("import os\nroot='/w'\np=os.path.join(root, 'a.txt')\nopen(p,'a').write('x')").map(w => w.path)).toEqual(['/w/a.txt'])
    expect(pythonWrites("from pathlib import Path\nR=Path('/w')\n(R / 'b' / 'c.md').write_text('x')").map(w => w.path)).toEqual(['/w/b/c.md'])
    expect(paths("python3 - notes.md <<'EOF'\nimport sys\np=sys.argv[1]\ns=open(p).read()\nopen(p,'w').write(s)\nEOF")).toEqual(['/w/notes.md'])
    expect(pythonWrites("open(f'{d}/x.txt', 'w').write('a')").map(w => w.path), 'unknown: reported, no path').toEqual([null])
  })

  test('reads and other modes are not writes', () => {
    expect(pythonWrites("s=open('a').read()\nopen('b','rb').read()\nwebbrowser.open('x')\nos.open('c', 1)")).toEqual([])
  })

  test('node: read-modify-write and literal text count, computed output does not', () => {
    expect(paths("node -e \"const fs=require('fs'); fs.writeFileSync('a.json', JSON.stringify(rows))\"")).toEqual([])
    const edit = "node - <<'EOF'\nconst fs = require('fs'); const P = 'src/x.js'; let b = fs.readFileSync(P, 'utf8');\nb = b.replace('a', 'b');\nfs.writeFileSync(P, b);\nEOF"
    expect(paths(edit)).toEqual(['/w/src/x.js'])
    expect(jsWrites("require('fs').writeFileSync('README.md', `# Hi`)").map(w => w.path)).toEqual(['README.md'])
    expect(paths("S=src/a.cjs && node -e 'const fs=require(\"fs\");let s=fs.readFileSync(process.argv[1],\"utf8\");fs.writeFileSync(process.argv[1],s)' \"$S\"")).toEqual(['/w/src/a.cjs'])
  })

  test('a script written to /tmp and run right away is read', () => {
    const cmd = "cat > /tmp/p.py <<'PY'\np = 'src/app.ts'\ns = open(p).read()\nopen(p, 'w').write(s)\nPY\npython3 /tmp/p.py && rm /tmp/p.py"
    expect(vias(cmd)).toEqual(['script:/w/src/app.ts'])
  })

  test('a script file on disk is not guessed at', () => {
    expect(paths('python3 scripts/migrate.py')).toEqual([])
    expect(paths('node build.js > out.txt')).toEqual([])
  })
})

describe('never local', () => {
  test('ssh, scp, rsync and docker exec run elsewhere', () => {
    expect(paths("ssh host \"sed -i 's/a/b/' /etc/x\"")).toEqual([])
    expect(paths("ssh host 'bash -s' <<'EOF'\nsed -i s/a/b/ /etc/x\necho a > /etc/y\nEOF")).toEqual([])
    expect(paths('scp f host:/x && rsync -a src/ host:dst/')).toEqual([])
    expect(paths("docker exec c sh -c 'echo a > /x'")).toEqual([])
    expect(paths("ssh host sed -i 's/a/b/' /etc/x")).toEqual([])
  })
})

describe('shells, wrappers and control flow', () => {
  test('bash -c, sh -c, bash <<EOF and eval are read as shell', () => {
    expect(paths("bash -c 'echo hi > z.txt'")).toEqual(['/w/z.txt'])
    expect(paths("sh -c \"sed -i 's/a/b/' f\"")).toEqual(['/w/f'])
    expect(paths("bash <<'EOF'\necho a > x.txt\nEOF")).toEqual(['/w/x.txt'])
    expect(paths("eval \"echo a > e.txt\"")).toEqual(['/w/e.txt'])
  })

  test('sudo tee and if/then', () => {
    expect(paths("sudo tee /etc/x.conf <<'EOF'\na=1\nEOF")).toEqual(['/etc/x.conf'])
    expect(paths('if [ -f x ]; then echo a >> x; fi')).toEqual(['/w/x'])
    expect(paths('while read l; do echo "$l"; done < in.txt > out.txt'), 'a loop prints what it read').toEqual([])
  })

  test('variables set in the command, $HOME and ~', () => {
    expect(paths('F=notes.md; echo a >> $F')).toEqual(['/w/notes.md'])
    expect(paths('echo a >> "$HOME/.bashrc"')).toEqual(['/home/u/.bashrc'])
    expect(paths('echo a >> ~/.bashrc')).toEqual(['/home/u/.bashrc'])
    expect(paths('D=/srv/app; cd $D && echo a > b')).toEqual(['/srv/app/b'])
    expect(paths('echo a > $UNKNOWN/f')).toEqual([null])
  })
})

describe('shell values inside Python and Node code (NE-1)', () => {
  test('an unquoted here-document: the shell fills in $VAR before Python reads it', () => {
    expect(paths("S=/tmp/s; python3 - <<EOF\nopen('$S/a','w').write('x')\nEOF")).toEqual(['/tmp/s/a'])
    expect(paths("export S=/tmp/s\npython3 - <<EOF\nopen('${S}/b.txt','w').write('x')\nEOF")).toEqual(['/tmp/s/b.txt'])
    expect(paths("python3 - <<EOF\nopen('$HOME/.cfg','w').write('x')\nEOF")).toEqual(['/home/u/.cfg'])
  })

  test('the session scratchpad through a variable is scratch, not a project file', () => {
    const cmd = "S=/tmp/claude-0/-root/1c48/scratchpad; python3 - <<EOF\nopen('$S/a6.js','w').write('x')\nEOF"
    const writes = findWrites(cmd, { cwd: '/w', home: '/home/u' })
    expect(writes.map(w => w.path)).toEqual(['/tmp/claude-0/-root/1c48/scratchpad/a6.js'])
    expect(judge(writes, { roots: ['/w'], temp: TEMP_DIRS }, settingsOf({})).refuse).toEqual([])
  })

  test('double-quoted -c and -e code too; a value only known at run time leaves the path unknown', () => {
    expect(paths("OUT=/tmp/x.txt; python3 -c \"open('$OUT','w').write('x')\"")).toEqual(['/tmp/x.txt'])
    expect(paths("python3 -c \"open('$TMPDIR/x.json','w').write('x')\"")).toEqual([null])
    expect(paths("node -e \"require('fs').writeFileSync('$TMPDIR/p','x')\"")).toEqual([null])
    expect(paths("python3 -c \"open('$(mktemp)','w').write('x')\"")).toEqual([null])
    expect(paths("T=/srv; python3 - <<EOF\nopen('$T/x/$NAME.txt','w').write('x')\nEOF")).toEqual([null])
    const unknown = findWrites("python3 -c \"open('$f.json','w').write('x')\"", { cwd: '/w' })
    expect(unknown[0]?.target, 'no shell variable shown as a file name').toBe('(a path the script computes)')
  })

  test('single quotes and quoted delimiters keep $ as written: Python sees it literally', () => {
    expect(paths("python3 -c 'open(\"$T/x\",\"w\").write(\"a\")'")).toEqual(['/w/$T/x'])
    expect(paths("S=/tmp/s; python3 - <<'EOF'\nopen('$S/a','w').write('x')\nEOF")).toEqual(['/w/$S/a'])
    expect(paths("python3 -c \"open('price\\$5.txt','w').write('x')\"")).toEqual(['/w/price$5.txt'])
    expect(paths("python3 - <<EOF\nopen('price\\$5.txt','w').write('x')\nEOF")).toEqual(['/w/price$5.txt'])
  })

  test('here-strings and perl -e', () => {
    expect(paths("D=/tmp/d; python3 - <<< \"open('$D/h','w').write('x')\"")).toEqual(['/tmp/d/h'])
    expect(paths("F=/tmp/o; perl -e \"open(my \\$fh, '>', '$F') or die\"")).toEqual(['/tmp/o'])
  })
})

describe('a temporary file moved over another (NE-4)', () => {
  test("another program's output through a filter is not an edit of the file it replaces", () => {
    expect(paths('curl -s https://x/y | jq . > data.json.tmp && mv data.json.tmp data.json')).toEqual([])
    expect(paths('npm view pkg version | head -1 > .v.tmp && mv .v.tmp .version')).toEqual([])
    expect(paths('git show HEAD:package.json | jq .version > v.tmp && mv v.tmp VERSION')).toEqual([])
    expect(paths("docker exec db psql -tAc 'select 1' | tr -d '\\n' > /w/.token.new && mv /w/.token.new /w/.token")).toEqual([])
    expect(paths("sed 's/x/y/' template.conf > app.conf.tmp && mv app.conf.tmp app.conf"), 'made from another file').toEqual([])
  })

  test('a filter that read the file it is moved over, or text the model wrote, is', () => {
    expect(vias('sort -u w.txt > w.tmp && mv w.tmp w.txt')).toEqual(['mv:/w/w.txt'])
    expect(vias("cat f | sed 's/a/b/' > f.tmp && mv f.tmp f"), 'read through a pipe').toEqual(['mv:/w/f'])
    expect(vias('echo x | sort > f.tmp && mv f.tmp f')).toEqual(['mv:/w/f'])
    expect(vias("grep -v old list.txt > /tmp/l && mv /tmp/l list.txt")).toEqual(['mv:/w/list.txt'])
  })
})

describe('xargs (NE-5)', () => {
  test('the files come from the command before it', () => {
    expect(paths("find /tmp/x -name '*.js' | xargs sed -i 's/a/b/'")).toEqual(['/tmp/x/**'])
    expect(paths("ls node_modules/pkg/*.js | xargs sed -i 's/a/b/'")).toEqual(['/w/node_modules/pkg/*.js'])
    expect(paths("echo /etc/a | xargs sed -i 's/a/b/'")).toEqual(['/etc/a'])
    expect(paths("grep -l foo a.ts b.ts | xargs sed -i 's/foo/bar/'")).toEqual(['/w/a.ts', '/w/b.ts'])
    expect(paths("rg -l foo src | xargs sed -i 's/foo/bar/'")).toEqual(['/w/src/**'])
    expect(paths("git diff --name-only | xargs perl -pi -e 's/a/b/'")).toEqual(['/w/**'])
    expect(paths("cat list.txt | xargs sed -i 's/a/b/'"), 'a list from a file is unknown').toEqual([null])
  })

  test('the files are named by the command that listed them', () => {
    const [found] = findWrites("find src -name '*.ts' | xargs sed -i 's/a/b/'", { cwd: '/w' })
    expect(found?.target).toBe('files find lists under src')
  })

  test('xargs -I and -i stand-ins are unknown paths, not files named {}', () => {
    expect(paths("mktemp | xargs -I{} sh -c 'echo a > {}'")).toEqual([null])
    expect(paths("ls *.txt | xargs -I F sh -c 'echo a > F.bak'")).toEqual([null])
    expect(paths("xargs -i sed -i 's/a/b/' {} < list.txt")).toEqual([null])
    expect(paths("git ls-files | xargs -I{} sed -i 's/a/b/' {}")).toEqual(['/w/**'])
  })
})

describe('parser gaps (NE-8)', () => {
  test('a backslash in the delimiter quotes the here-document', () => {
    expect(paths('cat > f <<\\EOF\nx $Y\nEOF')).toEqual(['/w/f'])
    expect(paths('cat > f <<E\\OF\nx $Y\nEOF')).toEqual(['/w/f'])
  })

  test('an escaped \\$ in an unquoted here-document is text', () => {
    expect(paths('cat > f <<EOF\nprice \\$5\nEOF')).toEqual(['/w/f'])
    expect(paths('cat > f <<EOF\nprice $5\nEOF')).toEqual([])
  })

  test('writes inside function bodies', () => {
    expect(paths('g() { echo x > f; }; g')).toEqual(['/w/f'])
    expect(paths('function g { echo x > f; }; g')).toEqual(['/w/f'])
    expect(paths("function g() {\n  sed -i 's/a/b/' h\n}\ng")).toEqual(['/w/h'])
    expect(paths('g () ( echo x > f )')).toEqual(['/w/f'])
  })

  test('awk -i inplace, ruby -i, yq -i and Deno.writeTextFile', () => {
    expect(vias("awk -i inplace '{gsub(/a/,\"b\")}1' f")).toEqual(['awk -i inplace:/w/f'])
    expect(paths("gawk -i inplace -v x=1 '{print}' f g")).toEqual(['/w/f', '/w/g'])
    expect(paths("awk '{print $1}' f > g")).toEqual([])
    expect(paths("awk -F, '{print}' f")).toEqual([])
    expect(vias("ruby -i -pe 'gsub(/a/,\"b\")' f")).toEqual(['ruby -i:/w/f'])
    expect(paths("ruby -pi.bak -e 'gsub(/a/,\"b\")' f g")).toEqual(['/w/f', '/w/g'])
    expect(paths("ruby -ne 'puts $_' f")).toEqual([])
    expect(vias("yq -i '.a = 1' c.yaml")).toEqual(['yq -i:/w/c.yaml'])
    expect(paths("yq e -i '.a = 1' c.yaml d.yaml")).toEqual(['/w/c.yaml', '/w/d.yaml'])
    expect(paths("yq '.a' c.yaml")).toEqual([])
    expect(paths("deno eval \"Deno.writeTextFileSync('n.md', '# x')\"")).toEqual(['/w/n.md'])
  })

  test('deep nesting neither overflows nor takes long; ordinary nesting is read', () => {
    const started = Date.now()
    for (const open of ['{ ', '( ']) {
      const close = open === '{ ' ? '; }' : ' )'
      const deep = `${open.repeat(2000)}echo a > f${close.repeat(2000)}`
      expect(() => findWrites(deep, { cwd: '/w' })).not.toThrow()
    }
    expect(Date.now() - started).toBeLessThan(1000)
    expect(paths('{ { { echo a > f; }; }; }')).toEqual(['/w/f'])
    expect(paths('( ( echo a > f ) )')).toEqual(['/w/f'])
  })
})

describe('robustness', () => {
  test('unfinished input never throws', () => {
    for (const s of ["echo 'unterminated > f", 'echo "a $(ls', 'cat <<EOF', 'echo $((', '((((((', '))))', '`echo', '${', 'a=(1 2', 'case x in a) echo > f;; esac', '|| && ;; & |']) {
      expect(() => findWrites(s, { cwd: '/w' })).not.toThrow()
      expect(() => parseShell(s)).not.toThrow()
    }
  })

  test('random shell-ish noise never throws', () => {
    const alphabet = ['a', ' ', '>', '>>', '<', '<<', "'", '"', '$', '(', ')', '{', '}', '`', '\\', '\n', ';', '&', '|', 'EOF', 'sed -i', 'cat', 'python3 -', 'open(', '#', '~', '*']
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let n = 0; n < 400; n++) {
      let s = ''
      const len = Math.floor(rand() * 40)
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)]
      expect(() => findWrites(s, { cwd: '/w' }), JSON.stringify(s)).not.toThrow()
    }
  })

  test('a 200 KB here-document is parsed quickly', () => {
    const body = 'const x = 1 // > not a redirect\n'.repeat(6000)
    const started = Date.now()
    expect(paths(`cat > big.ts <<'EOF'\n${body}EOF`)).toEqual(['/w/big.ts'])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('paths normalize', () => {
    expect(resolvePath('../b/./c', '/w/a')).toBe('/w/b/c')
    expect(resolvePath('/x//y/', '/w')).toBe('/x/y')
    expect(paths('echo a > ./sub/../f.txt')).toEqual(['/w/f.txt'])
  })
})
