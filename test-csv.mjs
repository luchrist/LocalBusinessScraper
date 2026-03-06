import * as XLSX from 'xlsx';

const csvContent = Buffer.from('Stadt,Branche\nÖstringen,Bäcker\n', 'utf8');

const wb1 = XLSX.read(csvContent, { type: 'buffer' });
const s1 = wb1.Sheets[wb1.SheetNames[0]];
console.log("From buffer:", XLSX.utils.sheet_to_json(s1));

const text = csvContent.toString('utf8');
const wb2 = XLSX.read(text, { type: 'string' });
const s2 = wb2.Sheets[wb2.SheetNames[0]];
console.log("From string:", XLSX.utils.sheet_to_json(s2));
