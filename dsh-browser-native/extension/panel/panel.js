const output = document.querySelector('#output')
const status = document.querySelector('#status')
const run = document.querySelector('#run')
const snapshot = document.querySelector('#snapshot')
const toolSelect = document.querySelector('#tool')
let tools = []

async function request(capability, method, args = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'capability.request', capability, method, args, sessionId: 'panel' })
  if (!response?.ok) throw new Error(response?.error ?? 'Browser request failed')
  return response.result
}

snapshot.addEventListener('click', async () => {
  snapshot.disabled = true; status.textContent = 'Reading…'
  try { const result = await chrome.runtime.sendMessage({ type: 'page.snapshot' }); if (result?.ok === false) throw new Error(result.error); output.textContent = result?.result?.text ?? 'No page snapshot returned.'; status.textContent = 'Connected' }
  catch (error) { output.textContent = String(error); status.textContent = 'Error' }
  finally { snapshot.disabled = false }
})

run.addEventListener('click', async () => {
  run.disabled = true; status.textContent = 'Running…'
  try {
    if (tools.length === 0) {
      tools = await request('webmcp', 'fetchTools')
      toolSelect.replaceChildren(...tools.map((tool, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `${tool.name} — ${tool.description ?? ''}`; return option }))
      run.textContent = 'Call selected tool'
      output.textContent = JSON.stringify(tools, null, 2)
    } else {
      const tool = tools[Number(toolSelect.value)]
      let input = {}
      const text = document.querySelector('#prompt').value.trim()
      if (text) input = JSON.parse(text)
      output.textContent = JSON.stringify(await request('webmcp', 'call', { tool, input }), null, 2)
    }
    status.textContent = 'Connected'
  }
  catch (error) { output.textContent = String(error); status.textContent = 'Error' }
  finally { run.disabled = false }
})
