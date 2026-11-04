import { evaluateCommand, evaluateFileWrite } from '../.agents/safety_hook.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { evaluateCommand, evaluateFileWrite };

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        inputData += chunk;
    });
    process.stdin.on('end', () => {
        try {
            const payload = inputData.trim() ? JSON.parse(inputData) : {};
            const toolName = payload?.toolCall?.name;
            let result;
            if (toolName === 'write_file' || toolName === 'edit_file') {
                result = evaluateFileWrite(payload);
            } else {
                result = evaluateCommand(payload);
            }
            process.stdout.write(JSON.stringify(result) + '\n');
        } catch (err) {
            process.stdout.write(JSON.stringify({
                decision: 'ask',
                reason: `Safety hook parse warning: ${err.message}`
            }) + '\n');
        }
    });
}
