const child  = require('child_process');
const Docker = require('dockerode');
const fs     = require('fs-extra');
const path   = require('path');
const tar    = require('tar');

const env = require('./env');

const { info, ok } = require('./logger');
const { slimdir, scriptdir } = env.vars();
const { formatMap } = require('./providers');

const docker = new Docker();

const formatSteps = {
    'raw': [dockerBuild, dockerExport, rawBuild],
    'iso': [dockerBuild, dockerExport, rawBuild, isoBuild, cleanup],
    'qcow2': [dockerBuild, dockerExport, rawBuild, isoBuild, qcowBuild, cleanup]
};

async function build(context) {
    let { provider, format } = context;

    // first element in the map is the provider's base format
    let [ base, ] = formatMap[provider];
    // use a set in case there are overlaps between steps
    let steps = new Set(formatSteps[base]);
    // add all additional steps for the requested formats
    format.forEach(f => formatSteps[f].forEach(s => steps.add(s)));

    // run each step in order
    for (let s of steps) {
        await s(context);
    }

    ok('success!');
}

async function dockerBuild(context) {
    info('building docker image');

    let { buildPath, dockerOpts } = context;

    if (!fs.existsSync(path.join(buildPath, 'Dockerfile')))
        throw new Error(`Expected Dockerfile in ${buildPath}`);

    const image = await docker.buildImage({ context: buildPath }, {
        t: 'slim-vm',
        ...dockerOpts
    });
    await new Promise((resolve, reject) => {
        docker.modem.followProgress(
            image,
            (err, res) => err ? reject(err) : resolve(res),
            ev => process.stdout.write(ev.stream)
        );
    });
}

async function dockerExport() {
    info('exporting docker filesystem');

    let image = 'slim-vm';
    let exportDir = path.join(slimdir, image);
    await fs.emptyDir(exportDir);

    const container = await docker.createContainer({ Image: image, Cmd: ['sh'] });

    const contents = await container.export();
    try {
        await new Promise((resolve, reject) => {
            contents.pipe(
                tar.x({ C: exportDir })
                   .on('close', resolve)
                   .on('error', err => reject(err))
            );
        });
    } catch (e) {
        throw e;
    } finally {
        container.remove().catch(() => undefined);
    }
}

async function rawBuild(context) {
    info('creating initrd');

    let { outputDir } = context;
    let vmDir = path.join(slimdir, 'slim-vm');

    await fs.move(path.join(vmDir, 'vmlinuz'), path.join(slimdir, 'vmlinuz'), { overwrite: true });
    child.execSync(`find . | cpio -o -H newc 2>/dev/null | gzip > ${path.join(slimdir, 'initrd')}`,
        {cwd: vmDir, stdio: 'inherit'});

    await fs.copy(path.join(slimdir, 'initrd'), path.join(outputDir, 'initrd'));
    await fs.copy(path.join(slimdir, 'vmlinuz'), path.join(outputDir, 'vmlinuz'));
}

async function isoBuild(context) {
    info('building iso');

    let { outputDir } = context;
    let outputPath = path.join(outputDir, 'slim.iso');

    let isoDir = path.join(slimdir, 'slim-iso')
    let bootDir = path.join(isoDir, 'boot');
    let isolinuxDir = path.join(isoDir, 'isolinux');

    await Promise.all([
        fs.emptyDir(isoDir),
        fs.emptyDir(bootDir),
        fs.emptyDir(isolinuxDir)
    ]);

    await fs.copy(path.join(scriptdir, 'scripts', 'syslinux'), isolinuxDir);
    await fs.copy(path.join(slimdir, 'vmlinuz'), path.join(bootDir, 'vmlinuz'));
    await fs.copy(path.join(slimdir, 'initrd'), path.join(bootDir, 'initrd'));

    child.execSync(`
        mkisofs -o ${outputPath} \
        -b isolinux/isolinux.bin \
        -c isolinux/boot.cat \
        -no-emul-boot -boot-load-size 4 -boot-info-table \
        -V slim -J -R ${isoDir}`, {stdio: 'inherit'});
}

async function qcowBuild(context) {
    info('building qcow2 image');

    let { outputDir } = context;

    child.execSync(`qemu-img convert -O qcow2 slim.iso slim.qcow2`,
        {cwd: outputDir, stdio: 'inherit'});
}

async function cleanup(context) {
    info('cleaning up...');

    let { provider, format, outputDir } = context;

    // we need the iso for qcow, but if we should remove it
    // if we aren't also building an iso image
    if (provider !== 'virtualbox' &&
        format.indexOf('iso') === -1) {
        await fs.remove(path.join(outputDir, 'slim.iso'));
        return;
    }

    // we need the raw images to build the iso, but we can
    // delete them afterwards
    if (provider === 'virtualbox' &&
        format.indexOf('raw') === -1) {
        await fs.remove(path.join(outputDir, 'initrd'));
        await fs.remove(path.join(outputDir, 'vmlinuz'));
        return;
    }
}

module.exports = build;
