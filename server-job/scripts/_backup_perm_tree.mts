import 'dotenv/config';
import { writeFileSync } from 'fs';
import { db } from '../src/perm/utils/db';

(async () => {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const tables = ['t_perm_menu', 't_perm_menu_action', 't_perm_role_perm', 't_perm_role_perm_baseline'];
  const dump: Record<string, unknown[]> = {};
  for (const t of tables) dump[t] = (await db(t).select('*')) as unknown[];
  const file = `../backup_perm_tree_${stamp}.json`;
  writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
  console.log(
    'backup ->',
    file,
    tables.map((t) => `${t}=${dump[t].length}`).join(' '),
  );
  await db.destroy();
})();
