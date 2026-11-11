export async function getTask(url, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`读取任务失败 (${response.status})`);
  return response.json();
}

export async function pollTasks(pollUrl, pollToken, fetchImpl = fetch) {
  const response = await fetchImpl(pollUrl, { headers: { 'X-Agent-Token': pollToken } });
  if (!response.ok) throw new Error(`轮询失败 (${response.status})`);
  return response.json();
}

export async function reportTask(report, result, fetchImpl = fetch) {
  const response = await fetchImpl(report.url, {
    method: 'POST',
    headers: { Origin: new URL(report.url).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  });
  if (!response.ok) throw new Error(`回报失败 (${response.status})`);
  return response.json();
}

export function parsePollDetails(content) {
  const match = String(content).match(/(?:通过网络访问|访问)\s+(https?:\/\/[^\s，,。]+\/api\/agents\/[^\s，,。]+\/tasks\/poll)[，,。\s]+请求头\s+X-Agent-Token:\s*([^。\s]+)/);
  if (!match) throw new Error('启动任务中没有找到 poll URL 和 X-Agent-Token');
  return { pollUrl: match[1], pollToken: match[2] };
}
