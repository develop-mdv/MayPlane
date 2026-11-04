"""Linux migration worker. Private configuration arrives on stdin, never argv."""
import base64
import copy
import hashlib
import ipaddress
import json
import os
import pwd
import grp
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time

class MigrationError(Exception):
    pass

def require(value, message):
    if not value:
        raise MigrationError(message)

def command(args, *, input=None, allowed=(0,)):
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode in allowed, 'Команда ' + args[0] + ' не выполнена (код ' + str(result.returncode) + ').')
    return result.stdout.decode('utf-8', errors='replace')

def docker(*args):
    return command(['docker', '--host', 'unix:///var/run/docker.sock', *args])

def inspect(ids):
    return json.loads(docker('inspect', '--size', *ids)) if ids else []

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def inside(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')

def safe_path(path):
    require(isinstance(path, str) and path.startswith('/') and len(path) < 1000 and not any(ord(c) < 32 for c in path), 'Некорректный путь данных')
    require('..' not in path.split('/'), 'Путь содержит ..')
    path = os.path.normpath(path)
    roots = ('/opt/', '/srv/', '/home/', '/root/', '/var/lib/', '/var/log/', '/var/cache/', '/etc/', '/usr/local/')
    require(path.startswith(roots) and path not in [r.rstrip('/') for r in roots], 'Нужен отдельный каталог приложения: ' + path)
    denied = ['/root/.ssh', '/etc/ssh', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d', '/etc/docker', '/etc/systemd', '/var/lib/docker', '/var/lib/containerd', '/opt/mayplane-migrations', '/opt/mayplane-backups']
    require(not any(inside(path, d) for d in denied), 'Системный или общий каталог нельзя переносить целиком: ' + path)
    return path

def unit_path(path):
    require(re.fullmatch(r'/etc/systemd/system/[A-Za-z0-9_.@:-]+\.service(?:\.d/[A-Za-z0-9_.-]+\.conf)?', path or ''), 'Неподдерживаемый файл службы: ' + str(path))
    return path

def unit_name(name):
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@:-]{0,180}\.service', name or ''), 'Некорректное имя службы')
    require(not re.match(r'^(ssh|sshd|docker|containerd|systemd|dbus|NetworkManager|networking|cron|ufw|firewalld)([.@-]|$)', name), 'Системную службу нельзя переносить как проект')
    return name

def host_info():
    require(os.geteuid() == 0, 'Для переноса нужен root-доступ')
    require('GNU tar' in command(['tar', '--version']), 'Требуется GNU tar')
    command(['sha256sum', '--version'])
    release = {}
    with open('/etc/os-release') as f:
        for line in f:
            if '=' in line:
                k, v = line.strip().split('=', 1)
                release[k] = v.strip('"')
    machine_id = ''
    if os.path.isfile('/etc/machine-id'):
        with open('/etc/machine-id') as f:
            machine_id = f.read().strip()
    return {'arch': os.uname().machine, 'os': release.get('ID'), 'version': release.get('VERSION_ID'), 'machineId': machine_id}

def path_size(path):
    return int(command(['du', '--apparent-size', '--block-size=1', '--summarize', '--', path]).split()[0])

def datasets_for(paths):
    selected = []
    for path in sorted(set(paths), key=lambda p: (len(p), p)):
        if any(inside(path, p) for p in selected):
            continue
        require(os.path.lexists(path), 'Не найден путь: ' + path)
        require(os.path.realpath(path) == path, 'Путь является ссылкой. Укажите реальный каталог: ' + path)
        require(os.path.isfile(path) or os.path.isdir(path), 'Необычный тип файла: ' + path)
        selected.append(path)
    return [{'key': 'path-' + str(i), 'source': p, 'target': p, 'kind': 'directory' if os.path.isdir(p) else 'file', 'bytes': path_size(p)} for i, p in enumerate(selected)]

def properties(unit):
    keys = ['Id', 'ActiveState', 'SubState', 'MainPID', 'WorkingDirectory', 'FragmentPath', 'DropInPaths', 'User', 'Group', 'SupplementaryGroups', 'DynamicUser', 'StateDirectory', 'CacheDirectory', 'LogsDirectory', 'ConfigurationDirectory', 'RuntimeDirectory', 'RootDirectory', 'RootImage', 'ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'EnvironmentFiles', 'TriggeredBy', 'Requires', 'BindsTo', 'UnitFileState', 'ControlGroup', 'Result']
    text = command(['systemctl', 'show', '--no-pager', '--property=' + ','.join(keys), '--', unit])
    return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)

def fingerprint_inventory(inv):
    if inv['runtime'] == 'docker':
        containers = []
        for c in sorted(inv['containers'], key=lambda c: c['Id']):
            record = {k: c.get(k) for k in ['Id', 'Image', 'Config', 'HostConfig']}
            record['Mounts'] = sorted(c['Mounts'], key=lambda m: m['Destination'])
            record['Endpoints'] = {name: {k: value[k] for k in ['IPAMConfig', 'Aliases', 'DriverOpts', 'GwPriority'] if value.get(k) is not None} for name, value in c.get('NetworkSettings', {}).get('Networks', {}).items()}
            containers.append(record)
        return digest({'containers': containers, 'paths': sorted(d['source'] for d in inv['datasets']), 'networks': inv['networks']})
    return digest({'units': {name: {k: re.sub(r' ; start_time=.*? }', ' }', v) if k.startswith('Exec') else v for k, v in unit.items()} for name, unit in inv['units'].items()}, 'ports': inv.get('ports', []), 'configs': inv['configHashes'], 'paths': sorted(d['source'] for d in inv['datasets'])})

def inventory(request):
    host = host_info()
    paths = [safe_path(p) for p in request.get('paths', [])]
    root = request.get('directory')
    if root and os.path.exists(root):
        paths.append(safe_path(root))
    for p in request.get('configFiles', []):
        if os.path.exists(p):
            paths.append(safe_path(p))
    ids, units = request.get('resources', []), request.get('units', [])
    if request.get('runtime') == 'auto':
        if shutil.which('docker'):
            ids = docker('ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + request['composeProject']).split()
        if not ids and not units and root:
            for line in command(['systemctl', 'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']).splitlines():
                name = line.strip().split()[0] if line.strip() else ''
                try:
                    unit_name(name)
                except MigrationError:
                    continue
                p = properties(name)
                if p.get('WorkingDirectory') and inside(p['WorkingDirectory'].lstrip('-'), root):
                    units.append(name)
    if not ids:
        require(not request.get('stopSignal'), 'Сигнал остановки задаётся только для Docker')
        return systemd_inventory(host, paths, units, request.get('allowStopped', False), request.get('allowRunning', False))
    require(not units, 'Смешанный запуск Docker и systemd требует отдельного плана')
    require(len(ids) <= 50 and all(re.fullmatch('[a-f0-9]{64}', x) for x in ids), 'Не удалось определить контейнеры проекта')
    containers = sorted(inspect(ids), key=lambda c: c['Id'])
    for c in containers:
        c['Mounts'] = sorted(c['Mounts'], key=lambda m: m['Destination'])
        # Preserve ports allocated by Docker when the original request used an empty host port.
        for key in (c['HostConfig'].get('PortBindings') or {}):
            actual = (c['NetworkSettings'].get('Ports') or {}).get(key)
            if actual:
                c['HostConfig']['PortBindings'][key] = copy.deepcopy(actual)
    require(len(containers) == len(ids), 'Состав контейнеров изменился')
    if request.get('allowRunning'):
        require(all(not c['State'].get('Paused') and not c['State'].get('Restarting') for c in containers), 'Дождитесь завершения перезапуска контейнеров')
    elif request.get('allowStopped'):
        require(all(not c['State']['Running'] and not c['State'].get('Paused') and not c['State'].get('Restarting') for c in containers), 'Конфликтующий контейнер работает. Выберите другой сервер или сначала остановите прежнюю копию.');
    else:
        require(all(c['State']['Running'] and not c['State'].get('Paused') for c in containers), 'Все контейнеры должны работать перед переносом')
    volumes, networks = {}, {}
    for c in containers:
        h = c['HostConfig']
        require(not (c['Config'].get('Labels') or {}).get('com.docker.swarm.service.name'), 'Сервисом управляет Swarm; нужен перенос через его контроллер')
        require(not h.get('VolumesFrom') and not h.get('Links') and not h.get('AutoRemove'), 'VolumesFrom, legacy links и автоматическое удаление требуют отдельного плана')
        require(not h.get('Tmpfs') and not h.get('StorageOpt'), 'Tmpfs или нестандартное хранилище контейнера требует отдельного плана')
        require(not any(str(h.get(k, '')).startswith('container:') for k in ['NetworkMode', 'PidMode', 'IpcMode']), 'Контейнер разделяет namespace с другим контейнером')
        require(not any(h.get(k) == 'host' for k in ['NetworkMode', 'PidMode', 'IpcMode']), 'Host namespaces требуют отдельного плана переноса настроек хоста')
        require(not h.get('DeviceRequests'), 'GPU-ресурсы требуют отдельной проверки целевого сервера')
        for m in c['Mounts']:
            if m['Type'] == 'bind':
                paths.append(safe_path(m['Source']))
            elif m['Type'] == 'volume':
                name = m['Name']
                v = json.loads(docker('volume', 'inspect', name))[0]
                require(v['Driver'] == 'local' and not v.get('Options'), 'Том ' + name + ' использует внешнее хранилище или драйвер')
                users = docker('ps', '-aq', '--no-trunc', '--filter', 'volume=' + name).split()
                require(set(users).issubset(set(ids)), 'Том ' + name + ' используется другим проектом')
                require(os.path.realpath(v['Mountpoint']) == v['Mountpoint'], 'Mountpoint тома является ссылкой')
                volumes[name] = v
            else:
                raise MigrationError('Неподдерживаемое хранилище: ' + m['Type'])
        for name in c['NetworkSettings']['Networks']:
            if name in ['bridge', 'none', 'host']:
                continue
            net = json.loads(docker('network', 'inspect', name))[0]
            require(net['Driver'] == 'bridge' and net.get('Scope', 'local') == 'local' and not net.get('Ingress'), 'Сеть ' + name + ' требует отдельного переноса')
            require(set((net.get('Containers') or {}).keys()).issubset(set(ids)), 'Сеть ' + name + ' используется другими контейнерами')
            networks[name] = {k: net[k] for k in ['Name', 'Driver', 'EnableIPv6', 'Internal', 'Attachable', 'IPAM', 'Options', 'Labels'] if k in net}
    for name, network in networks.items():
        fixed = any(c['NetworkSettings']['Networks'].get(name, {}).get('IPAMConfig') for c in containers)
        if not fixed:
            network.get('IPAM', {}).pop('Config', None)
    datasets = datasets_for(paths)
    for i, (name, volume) in enumerate(sorted(volumes.items())):
        datasets.append({'key': 'volume-' + str(i), 'source': volume['Mountpoint'], 'target': None, 'volume': name, 'kind': 'directory', 'bytes': path_size(volume['Mountpoint'])})
    all_ids = docker('ps', '-aq', '--no-trunc').split()
    for other in inspect([x for x in all_ids if x not in ids]):
        for m in other['Mounts']:
            if m['Type'] == 'bind' and any(inside(m['Source'], d['source']) or inside(d['source'], m['Source']) for d in datasets if not d.get('volume')):
                raise MigrationError('Каталог данных также подключён к другому контейнеру: ' + m['Source'])
    inv = {'runtime': 'docker', 'stopSignal': request.get('stopSignal') or '', 'host': host, 'daemonId': docker('info', '--format', '{{.ID}}').strip(), 'containers': containers, 'networks': networks, 'volumes': volumes, 'datasets': datasets, 'imageBytes': sum(c.get('SizeRootFs', 0) for c in containers), 'warnings': []}
    return finish_inventory(inv)

def validate_datasets(datasets):
    # Inspect structure while the source is still running; content hashes follow after stop.
    for dataset in datasets:
        path = dataset['source']
        entries = [path]
        if os.path.isdir(path):
            for root, dirs, files in os.walk(path, followlinks=False):
                entries.extend(os.path.join(root, name) for name in dirs + files)
        hardlinks = {}
        for filename in entries:
            st = os.lstat(filename)
            require(stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode), 'В данных найден socket/device/FIFO: ' + filename)
            if stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
                key = (st.st_dev, st.st_ino)
                count, expected = hardlinks.get(key, (0, st.st_nlink))
                hardlinks[key] = (count + 1, expected)
            if stat.S_ISLNK(st.st_mode):
                resolved = os.path.realpath(filename)
                require(any(inside(resolved, d['source']) for d in datasets) or resolved.startswith(('/usr/', '/lib/', '/bin/')), 'Ссылка ведёт к невыбранным данным: ' + resolved)
        require(all(count == expected for count, expected in hardlinks.values()), 'Жёсткие ссылки выходят за границы копируемого каталога: ' + path)


def finish_inventory(inv):
    require(inv['datasets'] or inv['runtime'] == 'docker', 'Не определены данные проекта')
    validate_datasets(inv['datasets'])
    inv['bytes'] = sum(x['bytes'] for x in inv['datasets']) + inv['imageBytes']
    stop_signal = inv.get('stopSignal') or ''
    require(stop_signal in ['', 'SIGTERM', 'SIGINT', 'SIGQUIT'], 'Некорректный сигнал остановки')
    require(not stop_signal or inv['runtime'] == 'docker', 'Сигнал остановки задаётся только для Docker')
    inv['stopSignal'] = stop_signal
    inv['fingerprint'] = fingerprint_inventory(inv)
    return inv

def systemd_inventory(host, paths, units, allow_stopped=False, allow_running=False):
    require(units, 'Не найден способ запуска. Укажите службы systemd и каталоги в дополнительных настройках переноса.')
    require(len(units) <= 20, 'Слишком много служб')
    records, accounts, configs, binaries, processes = {}, {}, {}, set(), set()
    for unit in units:
        unit_name(unit)
        p = properties(unit)
        if allow_running:
            require(p.get('ActiveState') in ['active', 'inactive', 'failed'], 'Служба меняет состояние: ' + unit)
        elif allow_stopped:
            require(p.get('ActiveState') in ['inactive', 'failed'] and p.get('MainPID', '0') == '0', 'Конфликтующая служба работает: ' + unit + '. Выберите другой сервер или сначала остановите её.')
        else:
            require(p.get('ActiveState') == 'active', 'Служба должна работать: ' + unit)
        require(p.get('DynamicUser') != 'yes' and not p.get('RootDirectory') and not p.get('RootImage'), 'DynamicUser и изолированные корневые каталоги требуют отдельного плана')
        require(not p.get('TriggeredBy'), 'Служба запускается через timer/socket: ' + p['TriggeredBy'])
        require(not p.get('RuntimeDirectory'), 'RuntimeDirectory удаляется при остановке; вынесите постоянные данные в StateDirectory')
        pid = p.get('MainPID', '0')
        if pid != '0':
            processes.add(pid)
        cgroup = '/sys/fs/cgroup' + p.get('ControlGroup', '')
        if p.get('ControlGroup') and os.path.isdir(cgroup):
            for directory, _, files in os.walk(cgroup):
                if 'cgroup.procs' in files:
                    with open(directory + '/cgroup.procs') as f:
                        processes.update(f.read().split())
        config_paths = [unit_path(p['FragmentPath'])] + [unit_path(x) for x in shlex.split(p.get('DropInPaths', ''))]
        for filename in config_paths:
            paths.append(filename)
            with open(filename, 'rb') as f:
                configs[filename] = hashlib.sha256(f.read()).hexdigest()
        if p.get('WorkingDirectory') and p['WorkingDirectory'] != '/':
            paths.append(safe_path(p['WorkingDirectory'].lstrip('-')))
        for key, prefix in [('StateDirectory', '/var/lib'), ('CacheDirectory', '/var/cache'), ('LogsDirectory', '/var/log'), ('ConfigurationDirectory', '/etc')]:
            for value in shlex.split(p.get(key, '')):
                path = safe_path(prefix + '/' + value.split(':')[0])
                if os.path.exists(path):
                    paths.append(path)
        for path in re.findall(r'(/\S+)\s+\(ignore_errors=', p.get('EnvironmentFiles', '')):
            paths.append(safe_path(path))
        user = p.get('User') or 'root'
        account = pwd.getpwnam(user) if not user.isdigit() else pwd.getpwuid(int(user))
        group = grp.getgrnam(p['Group']) if p.get('Group') else grp.getgrgid(account.pw_gid)
        accounts[user] = {'user': account.pw_name, 'uid': account.pw_uid, 'group': group.gr_name, 'gid': group.gr_gid}
        for key in ['ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost']:
            binaries.update(re.findall(r'path=([^ ;]+)', p.get(key, '')))
        records[unit] = {k: p.get(k, '') for k in ['Id', 'WorkingDirectory', 'FragmentPath', 'DropInPaths', 'User', 'Group', 'SupplementaryGroups', 'ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'UnitFileState', 'Requires', 'BindsTo']}
    datasets = datasets_for(paths)
    needed = set()
    for binary in binaries:
        if not any(inside(binary, d['source']) for d in datasets):
            needed.add(binary)
        if os.path.isfile(binary):
            with open(binary, 'rb') as f:
                header = f.read(256)
            if header.startswith(b'#!'):
                needed.add(header.splitlines()[0][2:].decode().strip().split()[0])
            elif header.startswith(b'\x7fELF'):
                needed.update(re.findall(r'(/[A-Za-z0-9_./+-]+)', command(['ldd', binary], allowed=(0, 1))))
    ports = set()
    for protocol, flag in [('tcp', '-ltnp'), ('udp', '-lunp')]:
        for line in command(['ss', '-H', flag]).splitlines():
            if processes.intersection(re.findall(r'pid=(\d+)', line)):
                columns = line.split()
                if len(columns) > 3:
                    address, port = columns[3].rsplit(':', 1)
                    require(address in ['*', '0.0.0.0', '[::]', '::', '127.0.0.1', '[::1]', '::1'], 'Служба слушает конкретный IP; исправьте конфигурацию перед переносом: ' + address)
                    ports.add((protocol, port))
    return finish_inventory({'runtime': 'systemd', 'ports': sorted(ports), 'host': host, 'units': records, 'accounts': accounts, 'binaries': sorted(needed), 'configHashes': configs, 'datasets': datasets, 'imageBytes': 0, 'warnings': ['Проверьте дополнительные каталоги и зависимости приложения. Настройки VPN, firewall и внешние базы не определяются только по unit-файлу.']})

def closest(path):
    while not os.path.exists(path):
        path = os.path.dirname(path)
    return path

def preflight(data):
    inv = data['inventory']
    host = host_info()
    issues, warnings = [], list(inv.get('warnings', []))
    if host.get('machineId') and host['machineId'] == inv['host'].get('machineId'):
        issues.append('Выбраны два подключения к одному серверу')
    if host['arch'] != inv['host']['arch']:
        issues.append('Архитектуры серверов различаются')
    reserve = 256 * 1024 * 1024
    required = inv['bytes'] * 3 + reserve
    if shutil.disk_usage(closest('/opt/mayplane-migrations')).free < required:
        issues.append('Недостаточно места на /opt: нужно не менее ' + str(required) + ' байт с резервом для копии и распаковки')
    disk_needs = {}
    for d in inv['datasets']:
        if d.get('volume'):
            continue
        if os.path.lexists(d['target']):
            issues.append('Путь уже существует на новом сервере: ' + d['target'])
        parent = closest(os.path.dirname(d['target']))
        if os.path.realpath(parent) != parent:
            issues.append('Родительский каталог является ссылкой: ' + parent)
        device = os.stat(parent).st_dev
        disk_needs.setdefault(device, {'path': parent, 'bytes': 0})['bytes'] += d['bytes']
    for disk in disk_needs.values():
        if shutil.disk_usage(disk['path']).free < disk['bytes'] + reserve:
            issues.append('Недостаточно места для данных на ' + disk['path'])
    if inv['runtime'] == 'docker':
        docker('info', '--format', '{{.ServerVersion}}')
        if inv.get('daemonId') == docker('info', '--format', '{{.ID}}').strip():
            issues.append('Источник и цель используют один Docker daemon')
        command(['curl', '--version'])
        docker_root = docker('info', '--format', '{{.DockerRootDir}}').strip()
        if shutil.disk_usage(docker_root).free < inv['bytes'] * 2 + reserve:
            issues.append('Недостаточно места в хранилище Docker')
        for c in inv['containers']:
            name = c['Name'].lstrip('/')
            if json.loads(command(['docker', '--host', 'unix:///var/run/docker.sock', 'container', 'inspect', name], allowed=(0, 1)).strip() or '[]'):
                issues.append('Контейнер с таким именем уже существует: ' + name)
            for device in c['HostConfig'].get('Devices') or []:
                if not os.path.exists(device['PathOnHost']):
                    issues.append('Нет устройства: ' + device['PathOnHost'])
            for binding_list in (c['HostConfig'].get('PortBindings') or {}).values():
                for binding in binding_list or []:
                    address = binding.get('HostIp', '')
                    if address not in ['', '0.0.0.0', '::', '127.0.0.1', '::1']:
                        issues.append('В настройках опубликованного порта указан конкретный IP: ' + address)
        existing_volumes = set(docker('volume', 'ls', '-q').split())
        for name in inv['volumes']:
            if name in existing_volumes:
                issues.append('Том уже существует: ' + name)
        target_nets = json.loads(docker('network', 'inspect', *docker('network', 'ls', '-q').split()))
        for name, net in inv['networks'].items():
            if any(n['Name'] == name for n in target_nets):
                issues.append('Сеть уже существует: ' + name)
            for config in net.get('IPAM', {}).get('Config') or []:
                if config.get('Subnet'):
                    a = ipaddress.ip_network(config['Subnet'], strict=False)
                    for n in target_nets:
                        for other in n.get('IPAM', {}).get('Config') or []:
                            if other.get('Subnet'):
                                b = ipaddress.ip_network(other['Subnet'], strict=False)
                                if a.version == b.version and a.overlaps(b):
                                    issues.append('Подсеть ' + str(a) + ' пересекается с сетью ' + n['Name'])
        occupied = set()
        for c in inspect(docker('ps', '-q').split()):
            for key, values in (c['NetworkSettings'].get('Ports') or {}).items():
                for binding in values or []:
                    occupied.add((key.split('/')[-1], binding['HostPort']))
        for protocol, flag in [('tcp', '-ltn'), ('udp', '-lun')]:
            for line in command(['ss', '-H', flag]).splitlines():
                columns = line.split()
                if len(columns) > 3:
                    occupied.add((protocol, columns[3].rsplit(':', 1)[-1]))
        for c in inv['containers']:
            for key, values in (c['HostConfig'].get('PortBindings') or {}).items():
                for b in values or []:
                    if (key.split('/')[-1], b['HostPort']) in occupied:
                        issues.append('Порт занят: ' + b['HostPort'] + '/' + key.split('/')[-1])
    else:
        occupied = set()
        for protocol, flag in [('tcp', '-ltn'), ('udp', '-lun')]:
            for line in command(['ss', '-H', flag]).splitlines():
                columns = line.split()
                if len(columns) > 3:
                    occupied.add((protocol, columns[3].rsplit(':', 1)[-1]))
        for protocol, port in inv.get('ports', []):
            if (protocol, port) in occupied:
                issues.append('Порт службы занят: ' + port + '/' + protocol)
        if (host['os'], host['version']) != (inv['host']['os'], inv['host']['version']):
            issues.append('Для переноса native-службы без пересборки нужны одинаковые ОС и версия')
        for unit, p in inv['units'].items():
            prop = command(['systemctl', 'show', '--property=LoadState', '--value', unit]).strip()
            if prop != 'not-found':
                issues.append('Служба уже существует: ' + unit)
            for group in shlex.split(p.get('SupplementaryGroups', '')):
                try:
                    grp.getgrnam(group)
                except KeyError:
                    issues.append('Нет дополнительной группы службы: ' + group)
            for dep in (p.get('Requires', '') + ' ' + p.get('BindsTo', '')).split():
                if dep.endswith('.service') and dep not in inv['units']:
                    if command(['systemctl', 'show', '--property=ActiveState', '--value', dep]).strip() != 'active':
                        issues.append('Не запущена зависимая служба: ' + dep)
        for account in inv['accounts'].values():
            try:
                u, g = pwd.getpwnam(account['user']), grp.getgrnam(account['group'])
                if u.pw_uid != account['uid'] or g.gr_gid != account['gid']:
                    issues.append('UID/GID пользователя отличаются: ' + account['user'])
            except KeyError:
                issues.append('Создайте пользователя ' + account['user'] + ' с UID ' + str(account['uid']) + ' и группу ' + account['group'] + ' с GID ' + str(account['gid']))
        for binary in inv['binaries']:
            if not os.path.exists(binary):
                issues.append('Не установлена зависимость: ' + binary)
    return {'blockers': sorted(set(issues)), 'warnings': sorted(set(warnings)), 'requiredBytes': required}

def workdir(job):
    require(re.fullmatch('[a-f0-9-]{36}', job), 'Некорректный идентификатор переноса')
    return '/opt/mayplane-migrations/' + job

def save_json(path, value):
    with open(path + '.tmp', 'w', encoding='utf8') as f:
        os.chmod(path + '.tmp', 0o600)
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path + '.tmp', path)

def prepare_dir(job):
    root = workdir(job)
    os.makedirs(root, mode=0o700, exist_ok=True)
    require(os.path.realpath(root) == root, 'Каталог переноса является ссылкой')
    os.chmod(root, 0o700)
    return root

def source_fence(inv, job, enable):
    root = prepare_dir(job)
    if inv['runtime'] == 'docker':
        for c in inv['containers']:
            policy = c['HostConfig'].get('RestartPolicy') or {}
            restart = 'no' if enable else (policy.get('Name') or 'no')
            if not enable and restart == 'on-failure' and policy.get('MaximumRetryCount'):
                restart += ':' + str(policy['MaximumRetryCount'])
            docker('update', '--restart=' + restart, c['Id'])
    else:
        fence = root + '/source-fenced'
        if enable:
            with open(fence, 'w') as f:
                f.write(job)
        for unit in inv['units']:
            directory = '/etc/systemd/system/' + unit + '.d'
            dropin = directory + '/zz-mayplane-migration-' + job + '.conf'
            if enable:
                os.makedirs(directory, mode=0o755, exist_ok=True)
                with open(dropin, 'x') as f:
                    f.write('[Unit]\nConditionPathExists=!' + fence + '\n')
            elif os.path.exists(dropin):
                os.unlink(dropin)
        command(['systemctl', 'daemon-reload'])
        if not enable and os.path.exists(fence):
            os.unlink(fence)

def stopped(inv, ids=None):
    if inv['runtime'] == 'docker':
        require(all(not c['State']['Running'] and not c['State'].get('Restarting') and not c['State'].get('Paused') for c in inspect(ids or [c['Id'] for c in inv['containers']])), 'Контейнеры ещё работают')
    else:
        for unit in inv['units']:
            p = properties(unit)
            require(p.get('ActiveState') in ['inactive', 'failed'] and p.get('MainPID', '0') == '0', 'Служба ещё работает: ' + unit)

def stop_source(data):
    inv, job = data['inventory'], data['job']
    stop_signal = inv.get('stopSignal') or ''
    require(stop_signal in ['', 'SIGTERM', 'SIGINT', 'SIGQUIT'], 'Некорректный сигнал остановки')
    source_fence(inv, job, True)
    if inv['runtime'] == 'docker':
        flags = ['--signal', stop_signal] if stop_signal else []
        docker('stop', '--time', '90', *flags, *[c['Id'] for c in inv['containers']])
    else:
        command(['systemctl', 'stop', '--', *inv['units'].keys()])
    stopped(inv)
    if inv['runtime'] == 'docker':
        require(all(c['State'].get('ExitCode') != 137 and not c['State'].get('OOMKilled') for c in inspect([c['Id'] for c in inv['containers']])), 'Контейнер остановлен принудительно. Проверьте завершение записи перед переносом.')
    else:
        require(all(properties(u).get('Result', 'success') not in ['timeout', 'signal', 'core-dump', 'watchdog', 'oom-kill'] for u in inv['units']), 'Служба остановилась аварийно; проверьте завершение записи перед переносом')
    return {'stopped': True}

def tree(path):
    result, links = {}, {}
    entries = [(path, '')]
    if os.path.isdir(path):
        for root, dirs, files in os.walk(path, followlinks=False):
            entries.extend((os.path.join(root, name), os.path.relpath(os.path.join(root, name), path)) for name in dirs + files)
    for filename, relative in sorted(entries):
        st = os.lstat(filename)
        kind = 'file' if stat.S_ISREG(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode) else 'symlink' if stat.S_ISLNK(st.st_mode) else 'unsupported'
        require(kind != 'unsupported', 'В данных найден socket/device/FIFO: ' + filename)
        meta = {'kind': kind, 'mode': stat.S_IMODE(st.st_mode), 'uid': st.st_uid, 'gid': st.st_gid}
        if kind == 'file':
            hasher = hashlib.sha256()
            with open(filename, 'rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''):
                    hasher.update(chunk)
            meta.update(size=st.st_size, sha256=hasher.hexdigest(), mtime=st.st_mtime_ns)
            if st.st_nlink > 1:
                meta['hardlink'] = links.setdefault((st.st_dev, st.st_ino), relative)
        if kind == 'symlink':
            meta['link'] = os.readlink(filename)
        meta['xattrs'] = {key: base64.b64encode(os.getxattr(filename, key, follow_symlinks=False)).decode() for key in os.listxattr(filename, follow_symlinks=False)}
        result[relative] = meta
    return result

def snapshot(data):
    inv, job = data['inventory'], data['job']
    root = prepare_dir(job)
    stopped(inv)
    validate_datasets(inv['datasets'])
    files, manifests, images = [], {}, []
    for d in inv['datasets']:
        before = tree(d['source'])
        for relative, entry in before.items():
            if entry['kind'] == 'symlink':
                resolved = os.path.realpath(os.path.join(d['source'], relative))
                require(any(inside(resolved, x['source']) for x in inv['datasets']) or resolved.startswith(('/usr/', '/lib/', '/bin/')), 'Ссылка ведёт к невыбранным данным: ' + resolved)
        archive = root + '/' + d['key'] + '.tar'
        args = ['tar', '--create', '--format=posix', '--numeric-owner', '--acls', '--xattrs', '--xattrs-include=*', '--sparse', '--file', archive]
        args += ['-C', d['source'], '.'] if d['kind'] == 'directory' else ['-C', os.path.dirname(d['source']), '--', os.path.basename(d['source'])]
        command(args)
        os.chmod(archive, 0o600)
        require(before == tree(d['source']), 'Данные изменялись во время создания копии: ' + d['source'])
        manifests[d['key']] = before
        files.append(archive)
    if inv['runtime'] == 'docker':
        for i, c in enumerate(inv['containers']):
            tag = 'mayplane-migration-' + job + ':c' + str(i)
            docker('commit', c['Id'], tag)
            details = json.loads(docker('image', 'inspect', tag))[0]
            image = details['Id']
            require(re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'Не удалось определить точный образ копии')
            images.append({'sourceId': c['Id'], 'tag': tag, 'id': image, 'contentFingerprint': image_content_fingerprint(details)})
        image_file = root + '/images.tar'
        docker('image', 'save', '-o', image_file, *[i['tag'] for i in images])
        os.chmod(image_file, 0o600)
        files.append(image_file)
    save_json(root + '/manifest.json', {'inventory': inv, 'trees': manifests, 'images': images})
    files.append(root + '/manifest.json')
    stopped(inv)
    return {'files': files, 'images': images, 'entries': sum(len(x) for x in manifests.values())}

def api(path, body):
    output = command(['curl', '--silent', '--show-error', '--fail-with-body', '--unix-socket', '/var/run/docker.sock', '-H', 'Content-Type: application/json', '--data-binary', '@-', 'http://localhost' + path], input=json.dumps(body).encode())
    return json.loads(output) if output.strip() else {}

def image_content_fingerprint(details):
    # Containerd and the classic image store may expose different IDs after load.
    # Config and uncompressed layer digests identify the content across both stores.
    return digest({k: details.get(k) for k in ['Os', 'Architecture', 'Variant', 'Config', 'RootFS']})

def loaded_image(image):
    details = json.loads(docker('image', 'inspect', image['tag']))[0]
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', details['Id']), 'Не определён загруженный образ')
    if image.get('contentFingerprint'):
        require(image_content_fingerprint(details) == image['contentFingerprint'], 'Содержимое загруженного образа не совпадает с исходным снимком')
    else:
        require(details['Id'] == image['id'], 'ID образа изменился между хранилищами Docker. Создайте свежую копию для проверки содержимого.')
    return {**image, 'id': details['Id']}

def container_spec(c, image, label, stop_signal=''):
    require(stop_signal in ['', 'SIGTERM', 'SIGINT', 'SIGQUIT'], 'Некорректный сигнал остановки')
    config = copy.deepcopy(c['Config'])
    config['Image'] = image['id']
    if stop_signal:
        config['StopSignal'] = stop_signal
    config['Labels'] = {**(config.get('Labels') or {}), 'mayplane.migration': label}
    h = copy.deepcopy(c['HostConfig'])
    h['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
    h.pop('ContainerIDFile', None)
    h['Binds'] = []
    mounts = []
    for m in c['Mounts']:
        original = next((x for x in h.get('Mounts', []) if x.get('Target') == m['Destination']), {})
        item = copy.deepcopy(original)
        item.update(Type=m['Type'], Source=m['Name'] if m['Type'] == 'volume' else m['Source'], Target=m['Destination'], ReadOnly=not m.get('RW', True))
        if m['Type'] == 'volume':
            item.setdefault('VolumeOptions', {})['NoCopy'] = True
        elif m.get('Propagation'):
            item.setdefault('BindOptions', {})['Propagation'] = m['Propagation']
        mounts.append(item)
    h['Mounts'] = mounts
    endpoints = {}
    for name, value in c['NetworkSettings']['Networks'].items():
        endpoint = {k: value[k] for k in ['IPAMConfig', 'Aliases', 'DriverOpts', 'GwPriority'] if value.get(k) is not None}
        if endpoint.get('Aliases'):
            endpoint['Aliases'] = [x for x in endpoint['Aliases'] if x not in [c['Id'], c['Id'][:12]]]
        endpoints[name] = endpoint
        if h.get('NetworkMode') == value.get('NetworkID'):
            h['NetworkMode'] = name
    return {**config, 'HostConfig': h, 'NetworkingConfig': {'EndpointsConfig': endpoints}}

def restore(data):
    job = data['job']
    root = prepare_dir(job)
    with open(root + '/manifest.json') as f:
        backup = json.load(f)
    inv = backup['inventory']
    report = preflight({'inventory': inv})
    require(not report['blockers'], '\n'.join(report['blockers']))
    journal = {'job': job, 'containers': [], 'paths': [], 'volumes': [], 'networks': [], 'ready': False}
    def record():
        save_json(root + '/target.json', journal)
    record()
    if inv['runtime'] == 'docker':
        docker('image', 'load', '-i', root + '/images.tar')
        images = [loaded_image(image) for image in backup['images']]
        journal['images'] = images
        record()
        for name, v in inv['volumes'].items():
            labels = {**(v.get('Labels') or {}), 'mayplane.migration': job}
            volume = api('/volumes/create', {'Name': name, 'Driver': 'local', 'Labels': labels})
            require((volume.get('Labels') or {}).get('mayplane.migration') == job, 'Том уже принадлежит другому приложению')
            journal['volumes'].append(name)
            record()
    for d in inv['datasets']:
        target = d['target']
        if d.get('volume'):
            target = json.loads(docker('volume', 'inspect', d['volume']))[0]['Mountpoint']
        else:
            require(not os.path.lexists(target), 'Путь появился после проверки: ' + target)
        if d['kind'] == 'directory':
            if not d.get('volume'):
                os.makedirs(os.path.dirname(target), exist_ok=True)
                os.mkdir(target, 0o700)
            require(not os.listdir(target), 'Каталог для восстановления не пуст')
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
        journal['paths'].append({'path': target, 'key': d['key']})
        record()
        destination = target if d['kind'] == 'directory' else os.path.dirname(target)
        command(['tar', '--extract', '--numeric-owner', '--same-owner', '--same-permissions', '--acls', '--xattrs', '--xattrs-include=*', '--file', root + '/' + d['key'] + '.tar', '-C', destination])
        require(tree(target) == backup['trees'][d['key']], 'Проверка восстановленных данных не прошла: ' + target)
    if inv['runtime'] == 'docker':
        for name, network in inv['networks'].items():
            config = copy.deepcopy(network)
            config['Labels'] = {**(config.get('Labels') or {}), 'mayplane.migration': job}
            result = api('/networks/create', config)
            journal['networks'].append(result['Id'])
            record()
        for c, image in zip(inv['containers'], images):
            result = api('/containers/create?name=' + c['Name'].lstrip('/'), container_spec(c, image, job, inv.get('stopSignal', '')))
            journal['containers'].append(result['Id'])
            record()
    else:
        command(['systemctl', 'daemon-reload'])
    journal['ready'] = True
    record()
    return journal

def target_journal(job):
    with open(workdir(job) + '/target.json') as f:
        journal = json.load(f)
    require(journal.get('ready') and journal.get('job') == job, 'Целевая копия ещё не подготовлена полностью')
    return journal

def target_owned(inv, job, journal):
    if inv['runtime'] == 'docker':
        actual = inspect(journal['containers'])
        require(len(actual) == len(inv['containers']) and all((c['Config'].get('Labels') or {}).get('mayplane.migration') == job for c in actual), 'Состав целевой копии изменился')
    else:
        for path, expected in journal.get('configHashes', inv['configHashes']).items():
            with open(path, 'rb') as f:
                require(hashlib.sha256(f.read()).hexdigest() == expected, 'Конфигурация перенесённой службы изменилась: ' + path)

def start_target(data):
    inv, job = data['inventory'], data['job']
    journal = target_journal(job)
    target_owned(inv, job, journal)
    if inv['runtime'] == 'docker':
        docker('start', *journal['containers'])
    else:
        command(['systemctl', 'start', '--', *inv['units'].keys()])
    return journal

def health(data):
    inv, job = data['inventory'], data['job']
    journal = target_journal(job)
    streak = 0
    for attempt in range(60):
        target_owned(inv, job, journal)
        if inv['runtime'] == 'docker':
            containers = inspect(journal['containers'])
            good = all(c['State']['Running'] and not c['State'].get('Restarting') and c['State'].get('Health', {}).get('Status', 'healthy') == 'healthy' for c in containers)
        else:
            good = all(properties(u).get('ActiveState') == 'active' for u in inv['units'])
        streak = streak + 1 if good else 0
        if streak >= 2:
            return {'healthy': True, 'resources': journal['containers'] if inv['runtime'] == 'docker' else ['systemd:' + u for u in inv['units']]}
        time.sleep(2)
    raise MigrationError('Проверка запуска новой копии не прошла. Данные на новом сервере сохранены.')

def enable_target(data):
    inv, job = data['inventory'], data['job']
    journal = target_journal(job)
    target_owned(inv, job, journal)
    if inv['runtime'] == 'docker':
        for source, target in zip(inv['containers'], journal['containers']):
            p = source['HostConfig'].get('RestartPolicy') or {}
            name = p.get('Name') or 'no'
            if name == 'on-failure' and p.get('MaximumRetryCount'):
                name += ':' + str(p['MaximumRetryCount'])
            docker('update', '--restart=' + name, target)
    else:
        for unit, p in inv['units'].items():
            if p['UnitFileState'] in ['enabled', 'enabled-runtime']:
                command(['systemctl', 'enable', '--', unit])
    return {'enabled': True}

def resume_source(data):
    inv, job = data['inventory'], data['job']
    source_fence(inv, job, False)
    if inv['runtime'] == 'docker':
        docker('start', *[c['Id'] for c in inv['containers']])
        require(all(c['State']['Running'] for c in inspect([c['Id'] for c in inv['containers']])), 'Исходный контейнер не запустился')
    else:
        command(['systemctl', 'start', '--', *inv['units'].keys()])
        require(all(properties(u).get('ActiveState') == 'active' for u in inv['units']), 'Исходная служба не запустилась')
    return {'running': True}

def verify_source(data):
    inv, job = data['inventory'], data['job']
    stopped(inv)
    with open(workdir(job) + '/manifest.json') as f:
        backup = json.load(f)
    for d in inv['datasets']:
        require(tree(d['source']) == backup['trees'][d['key']], 'Исходные данные изменились после копирования: ' + d['source'])
    return {'unchanged': True}

def assist_context(data):
    # Only fixed metadata queries; no .env, process environment or database contents leave the host.
    facts = {'arch': os.uname().machine, 'tools': {name: bool(shutil.which(name)) for name in ['docker', 'python3', 'tar', 'curl', 'ss', 'systemctl']}}
    if os.path.isfile('/etc/os-release'):
        with open('/etc/os-release') as f:
            facts['os'] = f.read()[:4000]
    directory = data.get('directory')
    if directory and os.path.isdir(directory):
        safe_path(directory)
        require(os.path.realpath(directory) == directory, 'Каталог является ссылкой')
        paths = []
        for root, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in ['.git', 'node_modules', '.venv', 'venv', 'uploads', 'data', 'logs', 'cache'])
            for name in sorted(dirs + files):
                filename = os.path.join(root, name)
                paths.append({'path': filename, 'directory': os.path.isdir(filename), 'symlink': os.path.islink(filename)})
                if len(paths) >= 300:
                    break
            if len(paths) >= 300:
                break
        facts['paths'] = paths
    if shutil.which('docker'):
        try:
            ids = docker('ps', '-aq', '--no-trunc').split()[:150]
            facts['containers'] = [{'id': c['Id'], 'name': c['Name'], 'running': c['State']['Running'], 'image': c['Config'].get('Image'), 'workdir': (c['Config'].get('Labels') or {}).get('com.docker.compose.project.working_dir'), 'mounts': c['Mounts'], 'ports': c['HostConfig'].get('PortBindings'), 'envKeys': [e.split('=', 1)[0] for e in c['Config'].get('Env') or []]} for c in inspect(ids)]
        except MigrationError:
            facts['dockerError'] = 'Docker недоступен'
    if shutil.which('systemctl'):
        try:
            units = []
            for line in command(['systemctl', 'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']).splitlines()[:150]:
                name = line.strip().split()[0] if line.strip() else ''
                try:
                    unit_name(name)
                except MigrationError:
                    continue
                p = properties(name)
                units.append({k: p.get(k) for k in ['Id', 'ActiveState', 'WorkingDirectory', 'FragmentPath', 'StateDirectory', 'ConfigurationDirectory', 'User', 'Group']})
            facts['units'] = units
        except MigrationError:
            facts['systemdError'] = 'systemd недоступен'
    return facts


def accept_target_config(data):
    inv, job = data['inventory'], data['job']
    journal = target_journal(job)
    if inv['runtime'] == 'systemd':
        hashes = {}
        for path in inv['configHashes']:
            unit_path(path)
            require(os.path.realpath(path) == path, 'Файл службы стал ссылкой')
            with open(path, 'rb') as f:
                hashes[path] = hashlib.sha256(f.read()).hexdigest()
        journal['configHashes'] = hashes
        save_json(workdir(job) + '/target.json', journal)
        command(['systemctl', 'daemon-reload'])
    return {'accepted': True}


def assert_no_writers(datasets):
    # Detect non-container writers too (manual processes, cron jobs, shared native services).
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            for fd in os.listdir('/proc/' + pid + '/fd'):
                path = os.readlink('/proc/' + pid + '/fd/' + fd).removesuffix(' (deleted)')
                if not any(inside(path, d['source']) for d in datasets):
                    continue
                with open('/proc/' + pid + '/fdinfo/' + fd) as f:
                    flags = next((line.split(':', 1)[1].strip() for line in f if line.startswith('flags:')), '0')
                require(int(flags, 8) & 3 == 0, 'Конфликтующие данные открыты для записи процессом ' + pid + '. Сначала остановите прежнее приложение.')
            with open('/proc/' + pid + '/maps') as f:
                for line in f:
                    columns = line.split(None, 5)
                    if len(columns) == 6 and 'w' in columns[1] and 's' in columns[1]:
                        path = columns[5].strip().removesuffix(' (deleted)')
                        require(not any(inside(path, d['source']) for d in datasets), 'Конфликтующие данные используются процессом ' + pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            raise MigrationError('Не удалось проверить открытые файлы процесса ' + pid)


def conflict_plan(data, check_space=True):
    incoming = data['inventory']
    paths = [d['target'] for d in incoming['datasets'] if not d.get('volume') and os.path.lexists(d['target'])]
    ids, units = [], []
    if incoming['runtime'] == 'docker':
        for c in incoming['containers']:
            found = json.loads(command(['docker', '--host', 'unix:///var/run/docker.sock', 'container', 'inspect', c['Name'].lstrip('/')], allowed=(0, 1)).strip() or '[]')
            ids.extend(x['Id'] for x in found)
    else:
        units = [u for u in incoming['units'] if command(['systemctl', 'show', '--property=LoadState', '--value', u]).strip() != 'not-found']
    if ids or units:
        inv = inventory({'runtime': incoming['runtime'], 'resources': ids, 'units': units, 'paths': [p for p in paths if not p.startswith('/etc/systemd/system/')], 'allowStopped': True, 'allowRunning': data.get('allowRunning', False)})
    else:
        for p in paths:
            unit_path(p) if p.startswith('/etc/systemd/system/') else safe_path(p)
        inv = {'runtime': incoming['runtime'], 'host': host_info(), 'containers': [], 'volumes': {}, 'networks': {}, 'units': {}, 'configHashes': {}, 'datasets': datasets_for(paths), 'imageBytes': 0, 'warnings': []}
    if incoming['runtime'] == 'docker':
        existing_volumes = set(docker('volume', 'ls', '-q').split())
        for name in incoming['volumes']:
            if name not in existing_volumes or name in inv['volumes']:
                continue
            require(not docker('ps', '-aq', '--filter', 'volume=' + name).strip(), 'Конфликтующий том используется другим контейнером: ' + name)
            v = json.loads(docker('volume', 'inspect', name))[0]
            require(v['Driver'] == 'local' and not v.get('Options'), 'Том использует внешнее хранилище: ' + name)
            require(os.path.realpath(v['Mountpoint']) == v['Mountpoint'], 'Mountpoint тома является ссылкой')
            inv['volumes'][name] = v
            inv['datasets'].append({'key': 'volume-extra-' + str(len(inv['datasets'])), 'source': v['Mountpoint'], 'target': None, 'volume': name, 'kind': 'directory', 'bytes': path_size(v['Mountpoint'])})
        existing_nets = set(docker('network', 'ls', '--format', '{{.Name}}').split())
        for name in incoming['networks']:
            if name not in existing_nets or name in inv['networks']:
                continue
            net = json.loads(docker('network', 'inspect', name))[0]
            require(not net.get('Containers'), 'Конфликтующая сеть используется другими контейнерами: ' + name)
            require(net['Driver'] == 'bridge' and net.get('Scope', 'local') == 'local', 'Общую сеть нельзя архивировать: ' + name)
            inv['networks'][name] = net
    # A directory collision alone must not cause files of another runtime to be moved.
    if shutil.which('docker'):
        for other in inspect(docker('ps', '-aq', '--no-trunc').split()):
            if other['Id'] in ids:
                continue
            for mount in other['Mounts']:
                require(not any(inside(mount['Source'], d['source']) or inside(d['source'], mount['Source']) for d in inv['datasets']), 'Конфликтующие данные использует другой контейнер: ' + other['Name'])
    for line in command(['systemctl', 'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']).splitlines():
        name = line.strip().split()[0] if line.strip() else ''
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service', name) or name in units:
            continue
        prop = properties(name)
        other_paths = [prop.get('WorkingDirectory', '').lstrip('-')]
        other_paths += re.findall(r'(/\S+)\s+\(ignore_errors=', prop.get('EnvironmentFiles', ''))
        for path in other_paths:
            if path and path != '/':
                require(not any(inside(path, d['source']) or inside(d['source'], path) for d in inv['datasets']), 'Конфликтующие данные использует другая служба: ' + name)
    running_ids = [c['Id'] for c in inv.get('containers', []) if c['State'].get('Running')]
    running_units = [u for u in inv.get('units', {}) if properties(u).get('ActiveState') == 'active']
    requires_stop = bool(running_ids or running_units)
    validate_datasets(inv['datasets'])
    if not requires_stop:
        assert_no_writers(inv['datasets'])
    inv['bytes'] = sum(d['bytes'] for d in inv['datasets']) + inv['imageBytes']
    inv['fingerprint'] = fingerprint_inventory(inv)
    needed = inv['bytes'] * 3 + 256 * 1024 * 1024
    if check_space:
        require(shutil.disk_usage(closest('/opt/mayplane-migrations')).free >= needed + incoming['bytes'] * 3, 'Недостаточно места для архива прежней копии и переноса')
    require(inv['datasets'] or inv.get('containers') or inv.get('networks') or inv.get('units'), 'Не удалось определить конфликтующие ресурсы')
    # Resource identities and file hashes must still match when approval is used.
    trees = {} if requires_stop else {d['key']: digest(tree(d['source'])) for d in inv['datasets']}
    resources = [c['Name'].lstrip('/') for c in inv.get('containers', [])] + list(inv.get('units', {}))
    resources += ['Том ' + n for n in inv.get('volumes', {})] + ['Сеть ' + n for n in inv.get('networks', {})]
    return {'requiresStop': requires_stop, 'runningIds': running_ids, 'runningUnits': running_units, 'releasesPorts': sorted(set([str(port) + '/' + proto for proto, port in inv.get('ports', [])] + [b['HostPort'] + '/' + key.split('/')[-1] for c in inv.get('containers', []) if c['Id'] in running_ids for key, bindings in (c['HostConfig'].get('PortBindings') or {}).items() for b in bindings or []])), 'inventory': inv, 'fingerprint': digest({'inventory': inv['fingerprint'], 'runningIds': running_ids, 'runningUnits': running_units, 'trees': trees, 'volumes': inv.get('volumes')}), 'resources': resources, 'paths': [d['source'] for d in inv['datasets'] if not d.get('volume')], 'bytes': inv['bytes']}


def archive_conflicts(data, prepared_root=False):
    current = conflict_plan(data)
    require(current['fingerprint'] == data['resolution']['fingerprint'], 'Конфликтующие данные изменились. Повторите проверку.')
    inv, job = current['inventory'], data['job']
    root = workdir(job)
    require(prepared_root or not os.path.lexists(root), 'Каталог архива уже существует. Повторите проверку переноса.')
    prepare_dir(job)
    journal = {'phase': 'snapshot', 'inventory': inv, 'completed': [], 'pending': None}
    def persist(action=None):
        journal['pending'] = action
        save_json(root + '/conflicts.json', journal)
    persist()
    # Keep every container's writable layer, configuration and logs in the archive.
    if inv.get('containers'):
        for i, c in enumerate(inv['containers']):
            logs = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', 'logs', '--timestamps', c['Id']], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            with open(root + '/container-' + str(i) + '.log', 'wb') as f:
                os.chmod(f.name, 0o600)
                f.write(logs.stdout)
    if inv['runtime'] == 'docker' and not inv.get('containers'):
        # snapshot's image-save stage needs at least one image.
        snapshot_inv = {**inv, 'runtime': 'systemd', 'units': {}}
    else:
        snapshot_inv = inv
    saved = snapshot({'inventory': snapshot_inv, 'job': job})
    journal['sha256'] = {}
    for filename in saved['files']:
        journal['sha256'][os.path.basename(filename)] = command(['sha256sum', '--', filename]).split()[0]
    persist()
    with open(root + '/manifest.json') as f:
        backup = json.load(f)
    backup['inventory'] = inv
    save_json(root + '/manifest.json', backup)
    journal['sha256']['manifest.json'] = command(['sha256sum', '--', root + '/manifest.json']).split()[0]
    persist()
    # Prove each archive restores identical contents, ownership and metadata before releasing names.
    for d in inv['datasets']:
        verify = root + '/verified-' + d['key']
        os.mkdir(verify, 0o700)
        command(['tar', '--extract', '--numeric-owner', '--same-owner', '--same-permissions', '--acls', '--xattrs', '--xattrs-include=*', '--delay-directory-restore', '--file', root + '/' + d['key'] + '.tar', '-C', verify])
        restored = verify if d['kind'] == 'directory' else verify + '/' + os.path.basename(d['source'])
        require(tree(restored) == backup['trees'][d['key']], 'Проверка архива не пройдена: ' + d['source'])
        require(tree(d['source']) == backup['trees'][d['key']], 'Прежние данные изменились во время архивирования: ' + d['source'])
    # A second metadata/ownership/stopped check closes the window during backup creation.
    require(conflict_plan(data, check_space=False)['fingerprint'] == current['fingerprint'], 'Конфликтующие ресурсы изменились во время архивирования; архив сохранён, имена не освобождены.')
    journal['phase'] = 'releasing'
    persist()
    for c in inv.get('containers', []):
        stopped(inv, [c['Id']])
        persist({'container': c['Id']})
        docker('rm', c['Id'])  # No force, no volume deletion; full snapshot is verified.
        journal['completed'].append(journal['pending'])
        persist()
    for name in inv.get('volumes', {}):
        require(not docker('ps', '-aq', '--filter', 'volume=' + name).strip(), 'Том стал использоваться другим контейнером')
        persist({'volume': name})
        docker('volume', 'rm', name)
        journal['completed'].append(journal['pending'])
        persist()
    for name in inv.get('networks', {}):
        require(not json.loads(docker('network', 'inspect', name))[0].get('Containers'), 'Сеть стала использоваться другим контейнером')
        persist({'network': name})
        docker('network', 'rm', name)
        journal['completed'].append(journal['pending'])
        persist()
    for unit in inv.get('units', {}):
        stopped(inv)
        persist({'disableUnit': unit})
        command(['systemctl', 'disable', '--', unit])
        journal['completed'].append(journal['pending'])
        persist()
    for d in inv['datasets']:
        if d.get('volume'):
            continue
        # Rename on the same filesystem, keeping the original in addition to the verified archive.
        destination = d['source'] + '.mayplane-archive-' + job
        require(not os.path.lexists(destination), 'Резервный путь уже существует: ' + destination)
        require(tree(d['source']) == backup['trees'][d['key']], 'Данные изменились перед перемещением в архив')
        persist({'path': d['source'], 'archivedPath': destination})
        os.rename(d['source'], destination)
        journal['completed'].append(journal['pending'])
        persist()
    if inv.get('units'):
        command(['systemctl', 'daemon-reload'])
    journal['phase'] = 'complete'
    persist()
    return {'archived': True, 'path': root}


def stop_archive_conflicts(data):
    current = conflict_plan({**data, 'allowRunning': True})
    require(current['fingerprint'] == data['resolution']['fingerprint'], 'Состав конфликтующей копии изменился. Повторите проверку.')
    if not current['requiresStop']:
        return archive_conflicts({**data, 'allowRunning': False})
    inv, job = current['inventory'], data['job']
    root = workdir(job)
    require(not os.path.lexists(root), 'Каталог архива уже существует')
    prepare_dir(job)
    record = {'phase': 'stopping', 'inventory': inv, 'runningIds': current['runningIds'], 'runningUnits': current['runningUnits']}
    save_json(root + '/stop.json', record)
    try:
        if inv['runtime'] == 'docker':
            for c in inv['containers']:
                docker('update', '--restart=no', c['Id'])
            if current['runningIds']:
                docker('stop', '--time', '90', *current['runningIds'])
                states = inspect(current['runningIds'])
                require(all(c['State'].get('ExitCode') != 137 and not c['State'].get('OOMKilled') for c in states), 'Прежняя копия остановлена принудительно. Архивирование не начато; проверьте данные.')
        else:
            command(['systemctl', 'stop', '--', *current['runningUnits']])
            require(all(properties(u).get('Result') not in ['timeout', 'signal', 'core-dump', 'watchdog', 'oom-kill'] for u in current['runningUnits']), 'Прежняя служба завершилась аварийно')
        stopped(inv)
        after = conflict_plan({**data, 'allowRunning': False})
        expected = copy.deepcopy(inv)
        if inv['runtime'] == 'docker':
            for c in expected['containers']:
                c['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        else:
            expected['ports'] = []  # Listening sockets disappear after a native service stops.
        require(fingerprint_inventory(expected) == after['inventory']['fingerprint'], 'Конфигурация прежней копии изменилась во время остановки')
        record['phase'] = 'archiving'
        save_json(root + '/stop.json', record)
        result = archive_conflicts({**data, 'allowRunning': False, 'resolution': after}, prepared_root=True)
        record['phase'] = 'complete'
        save_json(root + '/stop.json', record)
        return result
    except Exception:
        # Never resurrect a partially released copy. Its verified archive remains available.
        released = False
        if os.path.exists(root + '/conflicts.json'):
            with open(root + '/conflicts.json') as f:
                released = json.load(f).get('phase') in ['releasing', 'complete']
        if not released:
            try:
                if inv['runtime'] == 'docker':
                    for c in inv['containers']:
                        policy = c['HostConfig'].get('RestartPolicy') or {}
                        name = policy.get('Name') or 'no'
                        if name == 'on-failure' and policy.get('MaximumRetryCount'):
                            name += ':' + str(policy['MaximumRetryCount'])
                        docker('update', '--restart=' + name, c['Id'])
                    if current['runningIds']:
                        docker('start', *current['runningIds'])
                        require(all(c['State']['Running'] for c in inspect(current['runningIds'])), 'Не удалось восстановить прежнюю копию')
                elif current['runningUnits']:
                    command(['systemctl', 'start', '--', *current['runningUnits']])
                    require(all(properties(u).get('ActiveState') == 'active' for u in current['runningUnits']), 'Не удалось восстановить прежние службы')
                record['phase'] = 'resumed'
            except Exception:
                record['phase'] = 'needs_attention'
        else:
            record['phase'] = 'needs_attention'
        save_json(root + '/stop.json', record)
        if record['phase'] == 'needs_attention':
            raise MigrationError('Подготовка цели не завершена. Проверьте прежнюю копию и журнал ' + root + '/stop.json. Исходный сервер не останавливался.')
        raise


def main(request):
    action, data = request['action'], request.get('data', {})
    methods = {'stop-archive-conflicts': stop_archive_conflicts, 'conflict-plan': conflict_plan, 'archive-conflicts': archive_conflicts, 'assist-context': assist_context, 'accept-config': accept_target_config, 'inventory': inventory, 'preflight': preflight, 'stop': stop_source, 'snapshot': snapshot, 'restore': restore, 'start': start_target, 'health': health, 'enable': enable_target, 'resume-source': resume_source, 'verify-source': verify_source}
    if action == 'reserve':
        return {'path': prepare_dir(data['job'])}
    if action == 'source-space':
        require(shutil.disk_usage(closest('/opt/mayplane-migrations')).free > data['bytes'] + 256 * 1024 * 1024, 'На исходном сервере недостаточно места для резервной копии')
        return {'ok': True}
    require(action in methods, 'Неизвестная операция переноса')
    return methods[action](data)

if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'data': main(json.load(sys.stdin))}))
    except MigrationError as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': 'Не удалось проверить или перенести ресурс (' + type(error).__name__ + ').'}))
