"""Shared Linux process-tree sampling; sampler is outside the measured tree."""
from pathlib import Path

def proc_info(pid):
    raw = Path(f'/proc/{pid}/stat').read_text()
    end = raw.rfind(')')
    fields = raw[end + 2:].split()
    return {'pid': pid, 'name': raw[raw.index('(')+1:end], 'ppid': int(fields[1]),
            'ticks': int(fields[11]) + int(fields[12]), 'reapedChildTicks': int(fields[13]) + int(fields[14]), 'startTicks': int(fields[19]), 'threads': int(fields[17])}

def sample(pid):
    all_processes = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try: all_processes[int(entry.name)] = proc_info(int(entry.name))
        except (OSError, ValueError, IndexError): pass
    selected = {pid}
    while True:
        expanded = selected | {p for p, info in all_processes.items() if info['ppid'] in selected}
        if expanded == selected: break
        selected = expanded
    processes = []
    for child in sorted(selected):
        if child not in all_processes: continue
        try:
            memory = {}
            for line in Path(f'/proc/{child}/smaps_rollup').read_text().splitlines():
                if ':' not in line: continue
                key, value = line.split(':', 1)
                if key in ('Rss', 'Pss', 'Private_Clean', 'Private_Dirty', 'Swap'):
                    memory[key] = int(value.split()[0]) * 1024
            processes.append({**all_processes[child], **memory})
        except (OSError, ValueError): pass
    return {'accountedTreeTicks': sum(p['ticks'] + p['reapedChildTicks'] for p in processes),
            'rssBytes': sum(p.get('Rss', 0) for p in processes),
            'pssBytes': sum(p.get('Pss', 0) for p in processes), 'processes': processes}
