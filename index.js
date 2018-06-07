// access plugin
const tlds      = require('haraka-tld');
const haddr     = require('address-rfc2822');
const net_utils = require('haraka-net-utils');
const utils     = require('haraka-utils');

exports.register = function () {
    const plugin = this;

    plugin.init_config();      // init plugin.cfg
    plugin.init_lists();
    plugin.load_access_ini();  // update with *.ini settings

    let p;
    for (p in plugin.cfg.white)    { plugin.load_file('white', p); }
    for (p in plugin.cfg.black)    { plugin.load_file('black', p); }
    for (p in plugin.cfg.re.white) { plugin.load_re_file('white', p); }
    for (p in plugin.cfg.re.black) { plugin.load_re_file('black', p); }

    if (plugin.cfg.check.conn) {
        plugin.register_hook('connect', 'rdns_access');
    }
    if (plugin.cfg.check.helo) {
        plugin.register_hook('helo',    'helo_access');
        plugin.register_hook('ehlo',    'helo_access');
    }
    if (plugin.cfg.check.mail) {
        plugin.register_hook('mail', 'mail_from_access');
    }
    if (plugin.cfg.check.rcpt) {
        plugin.register_hook('rcpt', 'rcpt_to_access');
    }

    if (plugin.cfg.check.any) {
        plugin.load_domain_file('domain', 'any');
        ['connect','helo','ehlo','mail','rcpt'].forEach(function (hook) {
            plugin.register_hook(hook, 'any');
        });
        plugin.register_hook('data_post', 'data_any');
    }
};

exports.init_config = function () {
    const plugin = this;

    plugin.cfg = {
        deny_msg: {
            conn: 'You are not allowed to connect',
            helo: 'That HELO is not allowed to connect',
            mail: 'That sender cannot send mail here',
            rcpt: 'That recipient is not allowed',
        },
        domain: {
            any:  'access.domains',
        },
        white: {
            conn: 'connect.rdns_access.whitelist',
            mail: 'mail_from.access.whitelist',
            rcpt: 'rcpt_to.access.whitelist',
        },
        black: {
            conn: 'connect.rdns_access.blacklist',
            mail: 'mail_from.access.blacklist',
            rcpt: 'rcpt_to.access.blacklist',
        },
        re: {
            black: {
                conn: 'connect.rdns_access.blacklist_regex',
                mail: 'mail_from.access.blacklist_regex',
                rcpt: 'rcpt_to.access.blacklist_regex',
                helo: 'helo.checks.regexps',
            },
            white: {
                conn: 'connect.rdns_access.whitelist_regex',
                mail: 'mail_from.access.whitelist_regex',
                rcpt: 'rcpt_to.access.whitelist_regex',
            },
        },
    };
};

exports.load_access_ini = function () {
    const plugin = this;
    const cfg = plugin.config.get('access.ini', {
        booleans: [
            '+check.any',
            '+check.conn',
            '-check.helo',
            '+check.mail',
            '+check.rcpt',
            '-rcpt.accept',
        ],
    }, function () {
        plugin.load_access_ini();
    });

    plugin.cfg.check = cfg.check;
    if (cfg.deny_msg) {
        let p;
        for (p in plugin.cfg.deny_msg) {
            if (cfg.deny_msg[p]) {
                plugin.cfg.deny_msg[p] = cfg.deny_msg[p];
            }
        }
    }

    plugin.cfg.rcpt = cfg.rcpt;

    // backwards compatibility
    const mf_cfg = plugin.config.get('mail_from.access.ini');
    if (mf_cfg && mf_cfg.general && mf_cfg.general.deny_msg) {
        plugin.cfg.deny_msg.mail = mf_cfg.general.deny_msg;
    }
    const rcpt_cfg = plugin.config.get('rcpt_to.access.ini');
    if (rcpt_cfg && rcpt_cfg.general && rcpt_cfg.general.deny_msg) {
        plugin.cfg.deny_msg.rcpt = rcpt_cfg.general.deny_msg;
    }
    const rdns_cfg = plugin.config.get('connect.rdns_access.ini');
    if (rdns_cfg && rdns_cfg.general && rdns_cfg.general.deny_msg) {
        plugin.cfg.deny_msg.conn = rdns_cfg.general.deny_msg;
    }
};

exports.init_lists = function () {
    const plugin = this;
    plugin.list = {
        black: { conn: {}, helo: {}, mail: {}, rcpt: {} },
        white: { conn: {}, helo: {}, mail: {}, rcpt: {} },
        domain: { any: {} },
    };
    plugin.list_re = {
        black: {},
        white: {},
    };
};

exports.get_domain = function (hook, connection, params) {

    switch (hook) {
        case 'connect':
            if (!connection.remote.host) return;
            if (connection.remote.host === 'DNSERROR') return;
            if (connection.remote.host === 'Unknown') return;
            return connection.remote.host;
        case 'helo':
        case 'ehlo':
            if (net_utils.is_ip_literal(params)) return;
            return params;
        case 'mail':
        case 'rcpt':
            if (params && params[0]) {
                return params[0].host;
            }
    }
    return;
};

exports.any = function (next, connection, params) {
    const plugin = this;
    if (!plugin.cfg.check.any) { return next(); }

    const hook = connection.hook;
    if (!hook) {
        connection.logerror(plugin, "hook detection failed");
        return next();
    }

    // step 1: get a domain name from whatever info is available
    const domain = plugin.get_domain(hook, connection, params);
    if (!domain) {
        connection.logdebug(plugin, `domain detect failed on hook: ${hook}`);
        return next();
    }
    if (!/\./.test(domain)) {
        connection.results.add(plugin, {
            fail: `invalid domain: ${domain}`, emit: true});
        return next();
    }

    const org_domain = tlds.get_organizational_domain(domain);
    if (!org_domain) {
        connection.loginfo(plugin, `no org domain from ${domain}`);
        return next();
    }

    // step 2: check for whitelist
    let file = plugin.cfg.domain.any;
    const cr = connection.results;
    if (plugin.in_list('domain', 'any', `!${org_domain}`)) {
        cr.add(plugin, {pass: `${hook}:${file}`, whitelist: true, emit: true});
        return next();
    }

    let email;
    if (hook === 'mail' || hook === 'rcpt') { email = params[0].address(); }
    if (email && plugin.in_list('domain', 'any', `!${email}`)) {
        cr.add(plugin, {pass: `${hook}:${file}`, whitelist: true, emit: true});
        return next();
    }

    if (plugin.in_list('domain', 'any', `!${domain}`)) {
        cr.add(plugin, {pass: hook +':'+ file, whitelist: true, emit: true});
        return next();
    }

    // step 3: check for blacklist
    file = plugin.cfg.domain.any;
    if (plugin.in_list('domain', 'any', org_domain)) {
        cr.add(plugin, {
            fail: `${file}(${org_domain})`, blacklist: true, emit: true});
        return next(DENY, "You are not welcome here.");
    }

    const pass_msg = hook ? `${hook}:any` : 'any';
    cr.add(plugin, {msg: `unlisted(${pass_msg})` });
    return next();
};

exports.rdns_access = function (next, connection) {
    const plugin = this;
    if (!plugin.cfg.check.conn) { return next(); }

    if (!connection.remote.ip) {
        connection.results.add(plugin, {err: 'no IP?!' });
        return next();
    }

    const r_ip = connection.remote.ip;
    const host = connection.remote.host;

    let addr;
    let file;
    const addrs = [ r_ip, host ];
    for (let i=0; i<addrs.length; i++) {
        addr = addrs[i];
        if (!addr) { continue; }  // empty rDNS host
        if (/[\w]/.test(addr)) { addr = addr.toLowerCase(); }

        file = plugin.cfg.white.conn;
        connection.logdebug(plugin, `checking ${addr} against ${file}`);
        if (plugin.in_list('white', 'conn', addr)) {
            connection.results.add(plugin, {
                pass: file, whitelist: true, emit: true});
            return next();
        }

        file = plugin.cfg.re.white.conn;
        connection.logdebug(plugin, `checking ${addr} against ${file}`);
        if (plugin.in_re_list('white', 'conn', addr)) {
            connection.results.add(plugin, {
                pass: file, whitelist: true, emit: true});
            return next();
        }
    }

    // blacklist checks
    for (let i=0; i < addrs.length; i++) {
        addr = addrs[i];
        if (!addr) { continue; }  // empty rDNS host
        if (/[\w]/.test(addr)) { addr = addr.toLowerCase(); }

        file = plugin.cfg.black.conn;
        if (plugin.in_list('black', 'conn', addr)) {
            connection.results.add(plugin, {fail: file, emit: true});
            return next(DENYDISCONNECT,
                `${host} [${r_ip}] ${plugin.cfg.deny_msg.conn}`);
        }

        file = plugin.cfg.re.black.conn;
        connection.logdebug(plugin, `checking ${addr} against ${file}`);
        if (plugin.in_re_list('black', 'conn', addr)) {
            connection.results.add(plugin, {fail: file, emit: true});
            return next(DENYDISCONNECT,
                `${host} [${r_ip}] ${plugin.cfg.deny_msg.conn}`);
        }
    }

    connection.results.add(plugin, {msg: 'unlisted(conn)' });
    return next();
};

exports.helo_access = function (next, connection, helo) {
    const plugin = this;
    if (!plugin.cfg.check.helo) { return next(); }

    const file = plugin.cfg.re.black.helo;
    if (plugin.in_re_list('black', 'helo', helo)) {
        connection.results.add(plugin, {fail: file, emit: true});
        return next(DENY, `${helo} ${plugin.cfg.deny_msg.helo}`);
    }

    connection.results.add(plugin, {msg: 'unlisted(helo)' });
    return next();
};

exports.mail_from_access = function (next, connection, params) {
    const plugin = this;
    if (!plugin.cfg.check.mail) { return next(); }

    const mail_from = params[0].address();
    if (!mail_from) {
        connection.transaction.results.add(plugin, {
            skip: 'null sender', emit: true});
        return next();
    }

    // address whitelist checks
    let file = plugin.cfg.white.mail;
    connection.logdebug(plugin, `checking ${mail_from} against ${file}`);
    if (plugin.in_list('white', 'mail', mail_from)) {
        connection.transaction.results.add(plugin, {pass: file, emit: true});
        return next();
    }

    file = plugin.cfg.re.white.mail;
    connection.logdebug(plugin, `checking ${mail_from} against ${file}`);
    if (plugin.in_re_list('white', 'mail', mail_from)) {
        connection.transaction.results.add(plugin, {pass: file, emit: true});
        return next();
    }

    // address blacklist checks
    file = plugin.cfg.black.mail;
    if (plugin.in_list('black', 'mail', mail_from)) {
        connection.transaction.results.add(plugin, {fail: file, emit: true});
        return next(DENY, `${mail_from} ${plugin.cfg.deny_msg.mail}`);
    }

    file = plugin.cfg.re.black.mail;
    connection.logdebug(plugin, `checking ${mail_from} against ${file}`);
    if (plugin.in_re_list('black', 'mail', mail_from)) {
        connection.transaction.results.add(plugin, {fail: file, emit: true});
        return next(DENY, `${mail_from} ${plugin.cfg.deny_msg.mail}`);
    }

    connection.transaction.results.add(plugin, {msg: 'unlisted(mail)' });
    return next();
};

exports.rcpt_to_access = function (next, connection, params) {
    const plugin = this;
    if (!plugin.cfg.check.rcpt) { return next(); }

    let pass_status = undefined;
    if (plugin.cfg.rcpt.accept) {
        pass_status = OK;
    }

    const rcpt_to = params[0].address();

    // address whitelist checks
    if (!rcpt_to) {
        connection.transaction.results.add(plugin, {
            skip: 'null rcpt', emit: true});
        return next();
    }

    let file = plugin.cfg.white.rcpt;
    if (plugin.in_list('white', 'rcpt', rcpt_to)) {
        connection.transaction.results.add(plugin, {pass: file, emit: true});
        return next(pass_status);
    }

    file = plugin.cfg.re.white.rcpt;
    if (plugin.in_re_list('white', 'rcpt', rcpt_to)) {
        connection.transaction.results.add(plugin, {pass: file, emit: true});
        return next(pass_status);
    }

    // address blacklist checks
    file = plugin.cfg.black.rcpt;
    if (plugin.in_list('black', 'rcpt', rcpt_to)) {
        connection.transaction.results.add(plugin, {fail: file, emit: true});
        return next(DENY, `${rcpt_to} ${plugin.cfg.deny_msg.rcpt}`);
    }

    file = plugin.cfg.re.black.rcpt;
    if (plugin.in_re_list('black', 'rcpt', rcpt_to)) {
        connection.transaction.results.add(plugin, {fail: file, emit: true});
        return next(DENY, `${rcpt_to} ${plugin.cfg.deny_msg.rcpt}`);
    }

    connection.transaction.results.add(plugin, {msg: 'unlisted(rcpt)' });
    return next();
};

exports.data_any = function (next, connection) {
    const plugin = this;
    if (!plugin.cfg.check.data && !plugin.cfg.check.any) {
        connection.transaction.results.add(plugin, {skip: 'data(disabled)'});
        return next();
    }

    const hdr_from = connection.transaction.header.get('From');
    if (!hdr_from) {
        connection.transaction.results.add(plugin, {
            fail: 'data(missing_from)'});
        return next();
    }

    const hdr_addr = haddr.parse(hdr_from)[0];
    if (!hdr_addr) {
        connection.transaction.results.add(plugin, {
            fail: 'data(unparsable_from)'
        });
        return next();
    }
    const hdr_dom = tlds.get_organizational_domain(hdr_addr.host());

    const file = plugin.cfg.domain.any;
    if (plugin.in_list('domain', 'any', `!${hdr_dom}`)) {
        connection.results.add(plugin, {
            pass: file, whitelist: true, emit: true});
        return next();
    }

    if (plugin.in_list('domain', 'any', hdr_dom)) {
        connection.results.add(plugin, {
            fail: `${file}(${hdr_dom})`, blacklist: true, emit: true});
        return next(DENY, "Email from that domain is not accepted here.");
    }

    connection.results.add(plugin, {msg: 'unlisted(any)' });
    return next();
};

exports.in_list = function (type, phase, address) {
    const plugin = this;
    if (!plugin.list[type][phase]) {
        console.log(`phase not defined: ${phase}`);
        return false;
    }
    if (plugin.list[type][phase][address.toLowerCase()]) { return true; }
    return false;
};

exports.in_re_list = function (type, phase, address) {
    const plugin = this;
    if (!plugin.list_re[type][phase]) { return false; }
    if (!plugin.cfg.re[type][phase].source) {
        plugin.logdebug(plugin, `empty file: ${plugin.cfg.re[type][phase]}`);
    }
    else {
        plugin.logdebug(plugin, `checking ${address} against ` +
            `${plugin.cfg.re[type][phase].source}`);
    }
    return plugin.list_re[type][phase].test(address);
};

exports.in_file = function (file_name, address, connection) {
    const plugin = this;
    // using indexOf on an array here is about 20x slower than testing against
    // a key in an object
    connection.logdebug(plugin, `checking ${address} against ${file_name}`);
    return (plugin.config.get(file_name, 'list')
        .indexOf(address) === -1) ? false : true;
};

exports.in_re_file = function (file_name, address) {
    // Since the helo.checks plugin uses this method, I tested to see how
    // badly if affected performance. It took 8.5x longer to run than
    // in_re_list.
    this.logdebug(this, `checking ${address} against ${file_name}`);
    const re_list = utils.valid_regexes(
        this.config.get(file_name, 'list'), file_name);
    for (let i=0; i < re_list.length; i++) {
        if (new RegExp('^' + re_list[i] + '$', 'i').test(address)) return true;
    }
    return false;
};

exports.load_file = function (type, phase) {
    const plugin = this;
    if (!plugin.cfg.check[phase]) {
        plugin.loginfo(plugin, `skipping ${plugin.cfg[type][phase]}`);
        return;
    }

    const file_name = plugin.cfg[type][phase];

    // load config with a self-referential callback
    const list = plugin.config.get(file_name, 'list', () => {
        plugin.load_file(type, phase);
    });

    // init the list store, type is white or black
    if (!plugin.list)       { plugin.list = { type: {} }; }
    if (!plugin.list[type]) { plugin.list[type] = {}; }

    // toLower when loading spends a fraction of a second at load time
    // to save millions of seconds during run time.
    const listAsHash = {};  // store as hash for speedy lookups
    for (let i=0; i<list.length; i++) {
        listAsHash[list[i].toLowerCase()] = true;
    }
    plugin.list[type][phase] = listAsHash;
};

exports.load_re_file = function (type, phase) {
    const plugin = this;
    if (!plugin.cfg.check[phase]) {
        plugin.loginfo(plugin, `skipping ${plugin.cfg.re[type][phase]}`);
        return;
    }

    const regex_list = utils.valid_regexes(
        plugin.config.get(
            plugin.cfg.re[type][phase],
            'list',
            function () {
                plugin.load_re_file(type, phase);
            })
    );

    // initialize the list store
    if (!plugin.list_re)       plugin.list_re = { type: {} };
    if (!plugin.list_re[type]) plugin.list_re[type] = {};

    // compile the regexes at the designated location
    plugin.list_re[type][phase] =
        new RegExp(`^(${regex_list.join('|')})$`, 'i');
};

exports.load_domain_file = function (type, phase) {
    const plugin = this;
    if (!plugin.cfg.check[phase]) {
        plugin.loginfo(plugin, `skipping ${plugin.cfg[type][phase]}`);
        return;
    }

    const file_name = plugin.cfg[type][phase];
    const list = plugin.config.get(file_name, 'list', function () {
        plugin.load_domain_file(type, phase);
    });

    // init the list store, if needed
    if (!plugin.list)       { plugin.list = { type: {} }; }
    if (!plugin.list[type]) { plugin.list[type] = {}; }

    // convert list items to LC at load (much faster than at run time)
    for (let i=0; i < list.length; i++) {
        if (list[i][0] === '!') {  // whitelist entry
            plugin.list[type][phase][list[i].toLowerCase()] = true;
            continue;
        }

        if (/@/.test(list[i][0])) {  // email address
            plugin.list[type][phase][list[i].toLowerCase()] = true;
            continue;
        }

        const d = tlds.get_organizational_domain(list[i]);
        if (!d) { continue; }
        plugin.list[type][phase][d.toLowerCase()] = true;
    }
};
