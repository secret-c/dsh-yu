import fs from 'node:fs';
import { search, scenario, calculate, error } from './full.mjs';

let output;
try {
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  output=input.action==='search'?search(input):
    input.action==='calculate'?calculate(input):
    input.action==='scenario'?scenario(input):
    error('INVALID_ACTION','action 必须是 search、calculate 或 scenario。');
} catch(e) {
  output=error('CALCULATION_ERROR','Tomimi 数据或公式执行失败：'+String(e.message??e));
}
process.stdout.write(JSON.stringify(output)+'\n');
