import { join } from 'node:path';
import { inject } from 'vitest';

// A test that forgets its own home still cannot reach the real one: os.homedir(),
// the Person store under ~/.local/share and XDG data paths all land in the run's
// temporary home. Child processes inherit it unless a test sets HOME itself.
const home = inject('isolated_home');
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, '.local', 'share');
