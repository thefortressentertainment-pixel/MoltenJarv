import type { ToolDefinition } from '../agent/types.js';
import { hasTts, speak } from '../voice/index.js';

export function speechTools(): ToolDefinition[] {
  return [
    {
      name: 'speak_text',
      system: 'voice',
      description:
        'Speak a short message aloud on the hub machine using the text-to-speech engine. Use for reminders, hands-free replies, or when the user asked you to speak.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to speak aloud' },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const text = String(args.text ?? '').trim();
        if (!text) return { ok: false, error: 'text is required' };
        if (!hasTts()) return { ok: false, error: 'no text-to-speech available on this platform' };
        await speak(text);
        return { ok: true, spoken: text };
      },
    },
  ];
}
