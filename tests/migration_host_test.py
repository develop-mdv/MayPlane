import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import copy

spec = importlib.util.spec_from_file_location('migration_host', Path(__file__).resolve().parents[1] / 'runner/migration-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class MigrationFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ezdeploy-migration-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir(mode=0o750)
        self.backup = self.root / 'backup'
        self.backup.mkdir(mode=0o700)
        self.target = self.root / 'target'

    def inventory(self):
        return {'runtime':'systemd','units':{},'configHashes':{},'datasets':[{'source':str(self.source),'target':str(self.target),'key':'data','kind':'directory','bytes':10000}],'imageBytes':0}

    def test_real_tar_roundtrip_database_permissions_links_sparse_xattrs(self):
        db = sqlite3.connect(self.source / 'app.sqlite')
        db.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)')
        db.executemany('INSERT INTO items VALUES(?,?)', [(i, str(i)) for i in range(100)])
        db.commit()
        db.close()
        data = self.source / 'upload.bin'
        data.write_bytes(os.urandom(128 * 1024))
        data.chmod(0o640)
        os.setxattr(data, 'user.migration-test', b'preserved')
        os.link(data, self.source / 'hardlink.bin')
        os.symlink('upload.bin', self.source / 'latest')
        with open(self.source / 'sparse', 'wb') as f:
            f.seek(16 * 1024 * 1024)
            f.write(b'end')
        inv = self.inventory()
        original_command = host.command
        def command(args, **kwargs):
            if args[0] == 'systemctl':
                return ''
            return original_command(args, **kwargs)
        with patch.object(host, 'prepare_dir', return_value=str(self.backup)), patch.object(host, 'workdir', return_value=str(self.backup)), patch.object(host, 'preflight', return_value={'blockers':[]}), patch.object(host, 'command', side_effect=command):
            host.snapshot({'inventory':inv,'job':'fixture'})
            host.restore({'job':'fixture'})
            self.assertEqual(host.tree(str(self.source)),host.tree(str(self.target)))
            host.verify_source({'inventory':inv,'job':'fixture'})
            self.assertEqual((self.target/'upload.bin').stat().st_ino,(self.target/'hardlink.bin').stat().st_ino)
            sparse=(self.target/'sparse').stat()
            self.assertLess(sparse.st_blocks * 512,sparse.st_size)
            db=sqlite3.connect(self.target/'app.sqlite')
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(db.execute('SELECT count(*) FROM items').fetchone()[0],100)
            db.execute("INSERT INTO items(value) VALUES('new')")
            db.commit()
            db.close()
            data.write_bytes(b'changed on source')
            with self.assertRaisesRegex(host.MigrationError,'изменились'):
                host.verify_source({'inventory':inv,'job':'fixture'})

    def test_reject_external_hardlink_before_stopping(self):
        data=self.source/'data'; data.write_text('important')
        os.link(data,self.root/'outside')
        with self.assertRaisesRegex(host.MigrationError,'Жёсткие ссылки'):
            host.validate_datasets(self.inventory()['datasets'])

    def test_reject_unselected_symlink_and_fifo_before_stopping(self):
        os.symlink(str(self.root/'outside'),self.source/'link')
        with self.assertRaisesRegex(host.MigrationError,'невыбранным'):
            host.validate_datasets(self.inventory()['datasets'])
        (self.source/'link').unlink()
        os.mkfifo(self.source/'socket-like')
        with self.assertRaisesRegex(host.MigrationError,'FIFO'):
            host.validate_datasets(self.inventory()['datasets'])

    def test_fingerprint_is_mount_order_independent_but_detects_configuration_changes(self):
        a={'Id':'a','Image':'sha256:1','Config':{'Env':['TOKEN=first']},'HostConfig':{},'Mounts':[{'Destination':'/b'},{'Destination':'/a'}]}
        b=copy.deepcopy(a); b['Mounts'].reverse()
        inv={'runtime':'docker','containers':[a],'datasets':[],'networks':{}}
        other={**inv,'containers':[b]}
        self.assertEqual(host.fingerprint_inventory(inv),host.fingerprint_inventory(other))
        b['NetworkSettings']={'Networks':{'internal':{'Aliases':['database']}}}
        self.assertNotEqual(host.fingerprint_inventory(inv),host.fingerprint_inventory(other))
        b.pop('NetworkSettings')
        b['Config']['Env']=['TOKEN=second']
        self.assertNotEqual(host.fingerprint_inventory(inv),host.fingerprint_inventory(other))

    def test_container_spec_preserves_anonymous_volume_and_original_parameters(self):
        c={'Id':'a'*64,'Config':{'Env':['TOKEN=secret'],'Cmd':['run'],'Labels':{}},'HostConfig':{'RestartPolicy':{'Name':'always'},'Binds':['/old:/data'],'CapAdd':['NET_ADMIN'],'Devices':[{'PathOnHost':'/dev/net/tun'}],'PortBindings':{'80/tcp':[{'HostPort':'8000'}]}},'Mounts':[{'Type':'volume','Name':'anonymous-id','Destination':'/data','RW':True}],'NetworkSettings':{'Networks':{'app-net':{'Aliases':['a'*12,'database']}}}}
        spec=host.container_spec(c,{'id':'sha256:snapshot'},'job')
        self.assertEqual(spec['Image'],'sha256:snapshot')
        self.assertEqual(spec['Env'],['TOKEN=secret'])
        self.assertEqual(spec['HostConfig']['Mounts'][0]['Source'],'anonymous-id')
        self.assertTrue(spec['HostConfig']['Mounts'][0]['VolumeOptions']['NoCopy'])
        self.assertEqual(spec['HostConfig']['RestartPolicy']['Name'],'no')
        self.assertEqual(spec['HostConfig']['CapAdd'],['NET_ADMIN'])
        self.assertEqual(spec['NetworkingConfig']['EndpointsConfig']['app-net']['Aliases'],['database'])
        self.assertEqual(c['HostConfig']['RestartPolicy']['Name'],'always')

    def test_native_preflight_reports_same_host_port_and_dependency_conflicts(self):
        inv=self.inventory()
        inv.update(host={'arch':'x86_64','os':'ubuntu','version':'24.04','machineId':'same-host'},bytes=1000,accounts={},binaries=[str(self.root/'missing-binary')],ports=[('tcp','8080')])
        def command(args, **kwargs):
            if args[0]=='ss' and '-ltn' in args: return 'LISTEN 0 128 127.0.0.1:8080 0.0.0.0:*'
            return ''
        with patch.object(host,'host_info',return_value=inv['host']), patch.object(host,'command',side_effect=command):
            report=host.preflight({'inventory':inv})
        self.assertTrue(any('одному серверу' in b for b in report['blockers']))
        self.assertTrue(any('8080/tcp' in b for b in report['blockers']))
        self.assertTrue(any('missing-binary' in b for b in report['blockers']))
        self.assertFalse(self.target.exists())

    def test_reviewed_target_configuration_updates_only_target_ownership_manifest(self):
        import json,hashlib
        unit=self.target
        unit.write_text('[Service]\nExecStart=/opt/app/run --new-host\n')
        inv={'runtime':'systemd','configHashes':{str(unit):'original-source-hash'}}
        journal={'job':'fixture','ready':True,'containers':[]}
        (self.backup/'target.json').write_text(json.dumps(journal))
        with patch.object(host,'workdir',return_value=str(self.backup)), patch.object(host,'unit_path',side_effect=lambda p:p), patch.object(host,'command',return_value=''):
            with self.assertRaises(host.MigrationError):host.target_owned(inv,'fixture',journal)
            host.accept_target_config({'inventory':inv,'job':'fixture'})
            updated=json.loads((self.backup/'target.json').read_text())
            host.target_owned(inv,'fixture',updated)
        self.assertEqual(inv['configHashes'][str(unit)],'original-source-hash')
        self.assertEqual(updated['configHashes'][str(unit)],hashlib.sha256(unit.read_bytes()).hexdigest())

    def test_docker_inventory_validates_and_keeps_reviewed_stop_signal(self):
        c={'Id':'a'*64,'Config':{},'HostConfig':{},'Mounts':[],'NetworkSettings':{'Networks':{}},'State':{'Running':True}}
        def docker(*args):return 'daemon' if args[0]=='info' else c['Id']
        with patch.object(host,'host_info',return_value={}), patch.object(host,'docker',side_effect=docker), patch.object(host,'inspect',side_effect=lambda ids:[c] if ids else []):
            result=host.inventory({'runtime':'docker','resources':[c['Id']],'stopSignal':'SIGINT'})
            self.assertEqual(result['stopSignal'],'SIGINT')
            self.assertIn('fingerprint',result)
            with self.assertRaises(host.MigrationError):host.inventory({'runtime':'docker','resources':[c['Id']],'stopSignal':'SIGKILL'})
        inv=self.inventory()
        result=host.finish_inventory(inv)
        self.assertEqual(result['stopSignal'],'')

    def test_reviewed_stop_signal_stays_graceful_and_is_preserved_on_target(self):
        c={'Id':'a'*64,'Config':{},'HostConfig':{},'Mounts':[],'NetworkSettings':{'Networks':{}}}
        inv={'runtime':'docker','containers':[c],'stopSignal':'SIGINT'}
        with patch.object(host,'source_fence') as fence, patch.object(host,'stopped'), patch.object(host,'docker') as docker, patch.object(host,'inspect',return_value=[{'State':{'ExitCode':0}}]):
            host.stop_source({'inventory':inv,'job':'fixture'})
            docker.assert_called_once_with('stop','--time','90','--signal','SIGINT','a'*64)
            inv['stopSignal']='SIGKILL'
            with self.assertRaises(host.MigrationError):host.stop_source({'inventory':inv,'job':'fixture'})
            self.assertEqual(fence.call_count,1)
        spec=host.container_spec(c,{'id':'snapshot'},'fixture','SIGINT')
        self.assertEqual(spec['StopSignal'],'SIGINT')
        self.assertNotIn('StopSignal',c['Config'])
        inv['stopSignal']='SIGINT'
        with patch.object(host,'source_fence'), patch.object(host,'stopped'), patch.object(host,'docker'), patch.object(host,'inspect',return_value=[{'State':{'ExitCode':137}}]):
            with self.assertRaises(host.MigrationError):host.stop_source({'inventory':inv,'job':'fixture'})

    def test_loaded_image_identity_survives_different_docker_stores_but_content_must_match(self):
        import json
        source={'Id':'sha256:'+'a'*64,'Os':'linux','Architecture':'amd64','Config':{'Env':['KEY=hidden'],'Cmd':['run']},'RootFS':{'Type':'layers','Layers':['sha256:one','sha256:two']}}
        expected={'id':source['Id'],'tag':'ezdeploy-migration-fixture:c0','contentFingerprint':host.image_content_fingerprint(source)}
        target={**copy.deepcopy(source),'Id':'sha256:'+'b'*64}
        with patch.object(host,'docker',return_value=json.dumps([target])):
            self.assertEqual(host.loaded_image(expected)['id'],target['Id'])
        target['RootFS']['Layers'].append('sha256:unexpected')
        with patch.object(host,'docker',return_value=json.dumps([target])):
            with self.assertRaises(host.MigrationError):host.loaded_image(expected)
        target=copy.deepcopy(source);target['Config']['Cmd']=['different']
        with patch.object(host,'docker',return_value=json.dumps([target])):
            with self.assertRaises(host.MigrationError):host.loaded_image(expected)

    def test_system_paths_cannot_be_migrated_as_application_data(self):
        for path in ['/etc','/etc/ssh','/root/.ssh','/var/lib/docker','/opt/ezdeploy-migrations/id','/srv/../etc']:
            with self.subTest(path=path),self.assertRaises(host.MigrationError):host.safe_path(path)
        self.assertEqual(host.safe_path('/opt/app'),'/opt/app')


    def test_conflict_archive_verifies_real_database_and_preserves_original_before_releasing_path(self):
        import json
        db = sqlite3.connect(self.source / 'app.sqlite')
        db.execute('CREATE TABLE data(value TEXT)')
        db.execute("INSERT INTO data VALUES('old customer data')")
        db.commit(); db.close()
        inv = self.inventory()
        inv['datasets'][0]['target'] = str(self.source)
        resolution = {'inventory':inv,'fingerprint':'same'}
        root = self.root / 'archive'
        with patch.object(host, 'conflict_plan', return_value=resolution), patch.object(host, 'workdir', return_value=str(root)):
            result = host.archive_conflicts({'inventory':inv,'resolution':resolution,'job':'fixture'})
        self.assertTrue(result['archived'])
        self.assertFalse(self.source.exists())
        preserved = Path(str(self.source) + '.ezdeploy-archive-fixture')
        self.assertTrue(preserved.exists())
        for location in [root / 'verified-data', preserved]:
            db = sqlite3.connect(location / 'app.sqlite')
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('SELECT value FROM data').fetchone()[0], 'old customer data')
            db.close()
        journal = json.loads((root/'conflicts.json').read_text())
        self.assertEqual(journal['phase'],'complete')
        self.assertEqual(journal['completed'][-1]['archivedPath'], str(preserved))
        self.assertEqual(os.stat(root/'manifest.json').st_mode & 0o777, 0o600)

    def test_conflict_archive_failure_leaves_original_untouched(self):
        self.source.joinpath('data').write_text('original')
        inv = self.inventory()
        resolution = {'inventory':inv,'fingerprint':'same'}
        root = self.root / 'archive'
        real_snapshot = host.snapshot
        def corrupt(data):
            result = real_snapshot(data)
            Path(root/'data.tar').write_bytes(b'corrupt archive')
            return result
        with patch.object(host,'conflict_plan',return_value=resolution), patch.object(host,'workdir',return_value=str(root)), patch.object(host,'snapshot',side_effect=corrupt), patch.object(host,'docker') as docker:
            with self.assertRaises(host.MigrationError):
                host.archive_conflicts({'inventory':inv,'resolution':resolution,'job':'fixture'})
            docker.assert_not_called()
        self.assertEqual(self.source.joinpath('data').read_text(),'original')
        self.assertFalse(Path(str(self.source)+'.ezdeploy-archive-fixture').exists())

    def test_conflict_approval_rejects_drift_without_creating_archive(self):
        root = self.root/'archive'
        with patch.object(host,'conflict_plan',return_value={'fingerprint':'changed'}), patch.object(host,'workdir',return_value=str(root)):
            with self.assertRaises(host.MigrationError):
                host.archive_conflicts({'resolution':{'fingerprint':'reviewed'},'job':'fixture'})
        self.assertFalse(root.exists())

    def test_running_container_cannot_be_archived(self):
        c={'Id':'a'*64,'State':{'Running':True},'HostConfig':{},'Mounts':[]}
        with patch.object(host,'host_info',return_value={}),patch.object(host,'inspect',return_value=[c]):
            with self.assertRaisesRegex(host.MigrationError,'работает'):
                host.inventory({'runtime':'docker','resources':[c['Id']],'allowStopped':True})


    def auto_stop_fixture(self):
        a={'Id':'a'*64,'Image':'old-image','Config':{},'HostConfig':{'RestartPolicy':{'Name':'always','MaximumRetryCount':0}},'Mounts':[],'NetworkSettings':{'Networks':{}},'State':{'Running':True}}
        b=copy.deepcopy(a);b['Id']='b'*64;b['State']['Running']=False
        inv={'runtime':'docker','containers':[a,b],'datasets':[],'networks':{},'volumes':{}}
        after=copy.deepcopy(inv)
        for c in after['containers']:
            c['State']['Running']=False
            c['HostConfig']['RestartPolicy']={'Name':'no','MaximumRetryCount':0}
        after['fingerprint']=host.fingerprint_inventory(after)
        return {'inventory':inv,'requiresStop':True,'fingerprint':'reviewed','runningIds':[a['Id']],'runningUnits':[]}, {'inventory':after,'requiresStop':False,'fingerprint':'stopped'}

    def test_auto_stop_archives_only_reviewed_copy_and_never_starts_previously_stopped_container(self):
        current,after=self.auto_stop_fixture()
        root=self.root/'auto-archive'
        with patch.object(host,'conflict_plan',side_effect=[current,after]),patch.object(host,'workdir',return_value=str(root)),patch.object(host,'docker') as docker,patch.object(host,'stopped'),patch.object(host,'inspect',return_value=[{'State':{'ExitCode':0}}]),patch.object(host,'archive_conflicts',return_value={'archived':True}) as archive:
            result=host.stop_archive_conflicts({'resolution':current,'job':'fixture'})
            self.assertTrue(result['archived'])
            self.assertIn(unittest.mock.call('stop','--time','90','a'*64),docker.call_args_list)
            self.assertFalse(any(c.args[0]=='start' for c in docker.call_args_list))
            self.assertEqual(archive.call_args.kwargs,{'prepared_root':True})

    def test_auto_stop_resumes_only_previously_running_copy_if_archive_fails_before_release(self):
        current,after=self.auto_stop_fixture()
        root=self.root/'auto-archive'
        with patch.object(host,'conflict_plan',side_effect=[current,after]),patch.object(host,'workdir',return_value=str(root)),patch.object(host,'docker') as docker,patch.object(host,'stopped'),patch.object(host,'inspect',return_value=[{'State':{'ExitCode':0,'Running':True}}]),patch.object(host,'archive_conflicts',side_effect=host.MigrationError('Archive failed')):
            with self.assertRaisesRegex(host.MigrationError,'Archive failed'):
                host.stop_archive_conflicts({'resolution':current,'job':'fixture'})
            starts=[c for c in docker.call_args_list if c.args[0]=='start']
            self.assertEqual(starts,[unittest.mock.call('start','a'*64)])
        import json
        self.assertEqual(json.loads((root/'stop.json').read_text())['phase'],'resumed')

    def test_auto_stop_never_restarts_partially_released_target(self):
        current,after=self.auto_stop_fixture()
        root=self.root/'auto-archive'
        def failed_archive(*args,**kwargs):
            host.save_json(str(root/'conflicts.json'),{'phase':'releasing'})
            raise host.MigrationError('Release interrupted')
        with patch.object(host,'conflict_plan',side_effect=[current,after]),patch.object(host,'workdir',return_value=str(root)),patch.object(host,'docker') as docker,patch.object(host,'stopped'),patch.object(host,'inspect',return_value=[{'State':{'ExitCode':0}}]),patch.object(host,'archive_conflicts',side_effect=failed_archive):
            with self.assertRaisesRegex(host.MigrationError,'Подготовка цели не завершена'):
                host.stop_archive_conflicts({'resolution':current,'job':'fixture'})
            self.assertFalse(any(c.args[0]=='start' for c in docker.call_args_list))

if __name__=='__main__':
    unittest.main(verbosity=2)
