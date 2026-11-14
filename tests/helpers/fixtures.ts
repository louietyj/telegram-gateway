export const LOUIE = { id: 40506052, is_bot: false, first_name: "Louie", last_name: "Tan", username: "louietyj" };
export const BOT = { id: 9010651977, is_bot: true, first_name: "Louie's Claude", username: "louietyj_claude_bot" };
export const GROUP = { id: -5595413740, type: "group", title: "Alaska TEST" };

let nextUpdateId = 1000;

export function message(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { message_id: 1, date: 1_763_150_000, chat: GROUP, from: LOUIE, text: "hello", ...fields };
}

export function update(field: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { update_id: nextUpdateId++, [field]: payload };
}
