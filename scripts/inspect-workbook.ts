import { readFile } from 'node:fs/promises';
import { parseWorkbook } from '../src/imports.js';
const file = process.argv[2] ?? 'D:/Car Details/Book1 - Updated.xlsx';
const parsed = await parseWorkbook(await readFile(file));
console.log(JSON.stringify(parsed, null, 2));
