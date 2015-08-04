/*
    irc.js - Node JS IRC client library

    (C) Copyright Martyn Smith 2010
	
	Modified for WEBIRC support, DarkSpirit IRC Network, 2015

    This library is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This library is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this library.  If not, see <http://www.gnu.org/licenses/>.
*/

exports.Client = Client;
var net  = require('net');
var tls  = require('tls');
var util = require('util');
var _    = require('underscore');

var carrier = require('carrier');

var colors = require('./colors');
exports.colors = colors;

var replyFor = require('./codes');


var log = require('../tapchat/log');

function Client(server, nick, opt) {
    var self = this;
    self.opt = {
        server: server,
        nick: nick,
        password: null,
        userName: 'nodebot',
        realName: 'nodeJS IRC client',
		cloakUser: null,
		cloakPasswd: null,
		ircvHost: null,
        port: 6667,
        debug: false,
        showErrors: false,
        autoRejoin: true,
        autoConnect: true,
        retryCount: null,
        retryDelay: 10000,
        secure: false,
        floodProtection: false,
        floodProtectionDelay: 1000,
        stripColors: false
    };

    if (typeof arguments[2] == 'object') {
        var keys = Object.keys(self.opt);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (arguments[2][k] !== undefined)
                self.opt[k] = arguments[2][k];
        }
    }

    if (self.opt.floodProtection) {
        self.activateFloodProtection();
    }

    // TODO - fail if nick or server missing
    // TODO - fail if username has a space in it
    if (self.opt.autoConnect === true) {
      self.connect();
    }

    self.addListener("raw", function (message) {
        switch ( message.command ) {
            case "001":
                self.hostname = message.prefix;
                // Set nick to whatever the server decided it really is
                // (normally this is because you chose something too long and
                // the server has shortened it
                self.nick = message.args[0];
                self.emit('registered', message);
                self.startHeartbeat();
                break;
            case "002":
            case "003":
            case "004":
                break;
            case "005":
                message.args.forEach(function(arg) {
                    var match;
                    if ( match = arg.match(/PREFIX=\((.*?)\)(.*)/) ) {
                        match[1] = match[1].split('');
                        match[2] = match[2].split('');
                        while ( match[1].length ) {
                            self.modeForPrefix[match[2][0]] = match[1][0];
                            self.prefixForMode[match[1].shift()] = match[2].shift();
                        }
                    }
                });
                break;
            case "rpl_luserclient":
            case "rpl_luserop":
            case "rpl_luserchannels":
            case "rpl_luserme":
            case "rpl_localusers":
            case "rpl_globalusers":
            case "rpl_statsconn":
                // Random welcome crap, ignoring
                break;
            case "err_nicknameinuse":
                if ( typeof(self.opt.nickMod) == 'undefined' )
                    self.opt.nickMod = 0;
                self.opt.nickMod++;
                self.send("NICK", self.opt.nick + self.opt.nickMod);
                self.nick = self.opt.nick + self.opt.nickMod;
                break;
            case "PING":
                self.send("PONG", message.args[0]);
                break;
            case "PONG":
                self.stopPingTimeout();
                break;
            case "NOTICE":
                var from = message.nick;
                var to   = message.args[0];
                if (!to) {
                    to   = null;
                }
                var text = message.args[1];
                if (text[0] === '\1' && text.lastIndexOf('\1') > 0) {
                    self._handleCTCP(from, to, text, 'notice');
                    break;
                }
                self.emit('notice', from, to, text, message);

                // if ( self.opt.debug && to == self.nick )
                    // log.debug('GOT NOTICE from ' + (from?'"'+from+'"':'the server') + ': "' + text + '"');
                break;
            case "MODE":
                log.debug("MODE: " + message.args.join(' '));

                var modeList = message.args[1].split('');
                var adding = true;
                var modeArgs = message.args.splice(2);
                modeList.forEach(function(mode) {
                    if ( mode == '+' ) { adding = true; return; }
                    if ( mode == '-' ) { adding = false; return; }
                    if ( mode in self.prefixForMode ) {
                        // user modes
                        var user = modeArgs.shift();
                        if ( adding ) {
                            self.emit('+mode', message.args[0], message.nick, mode, user, message);
                        }
                        else {
                            self.emit('-mode', message.args[0], message.nick, mode, user, message);
                        }
                    }
                    else {
                        var modeArg;
                        // channel modes
                        if ( mode.match(/^[bkl]$/) ) {
                            modeArg = modeArgs.shift();
                            if ( modeArg.length === 0 )
                                modeArg = undefined;
                        }
                        // TODO - deal nicely with channel modes that take args
                        if ( adding ) {
                            self.emit('+mode', message.args[0], message.nick, mode, modeArg, message);
                        }
                        else {
                            self.emit('-mode', message.args[0], message.nick, mode, modeArg, message);
                        }
                    }
                });
                break;
            case "NICK":
                // irssi-proxy workaround. If irssi reconnects to server it
                // doesn't send us a new 001 message, so if our nick was changed
                // we wouldn't know about it.
                if (message.nick == null || typeof(message.nick) === 'undefined') {
                    message.nick = self.nick;
                }

                var newNick = message.args[0];
                log.debug("NICK: " + message.nick + " changes nick to " + newNick);

                if (message.nick === self.nick) {
                    self.nick = newNick;
                    self.emit('selfNick', message.nick, newNick, message);
                } else {
                    // old nick, new nick
                    self.emit('nick', message.nick, newNick, message);
                }
                
                break;
            case "rpl_motdstart":
                self.motd = message.args[1] + "\n";
                break;
            case "rpl_motd":
                self.motd += message.args[1] + "\n";
                break;
            case "rpl_endofmotd":
            case "err_nomotd":
                self.motd += message.args[1] + "\n";
                self.emit('motd', self.motd);
                break;
            case "rpl_namreply":
                var users = message.args[3].trim().split(/ +/);
                var names = _.object(users.map(function (user) {
                    var nick = user;
                    var prefix = '';
                    if (user[0] in self.modeForPrefix) {
                        prefix = self.modeForPrefix[user[0]];
                        nick = user.substring(1);
                    }
                    return [nick, prefix];
                }));
                self.emit('names', message.args[2], names, message);
                break;
            case "rpl_endofnames":
                self.emit('end_of_names', message.args[1], message);
                self.send('MODE', message.args[1]);
                break;
            case "rpl_topic":
                self.emit('topic', message.args[1], message.args[2], null, null);
                break;
            case "rpl_notopic":
                self.emit('topic', message.args[1], null, null, null);
                break;
            case "rpl_away":
                self._addWhoisData(message.args[1], 'away', message.args[2], true);
                break;
            case "rpl_whoisuser":
                self._addWhoisData(message.args[1], 'user', message.args[2]);
                self._addWhoisData(message.args[1], 'host', message.args[3]);
                self._addWhoisData(message.args[1], 'realname', message.args[5]);
                break;
            case "rpl_whoisidle":
                self._addWhoisData(message.args[1], 'idle', message.args[2]);
                break;
            case "rpl_whoischannels":
                self._addWhoisData(message.args[1], 'channels', message.args[2].trim().split(/\s+/)); // TODO - clean this up?
                break;
            case "rpl_whoisserver":
                self._addWhoisData(message.args[1], 'server', message.args[2]);
                self._addWhoisData(message.args[1], 'serverinfo', message.args[3]);
                break;
            case "rpl_whoisoperator":
                self._addWhoisData(message.args[1], 'operator', message.args[2]);
                break;
            case "330": // rpl_whoisaccount?
                self._addWhoisData(message.args[1], 'account', message.args[2]);
                self._addWhoisData(message.args[1], 'accountinfo', message.args[3]);
                break;
            case "rpl_endofwhois":
                self.emit('whois', self._clearWhoisData(message.args[1]));
                break;
            case "rpl_liststart":
                self.channellist = [];
                self.emit('channellist_start');
                break;
            case "rpl_list":
                var channel = {
                    name: message.args[1],
                    users: message.args[2],
                    topic: message.args[3],
                };
                self.emit('channellist_item', channel);
                self.channellist.push(channel);
                break;
            case "rpl_listend":
                self.emit('channellist', self.channellist);
                break;
            case "333":
                // FIXME: self.emit('topic', message.args[1], message.args[2], message);
                break;
            case "TOPIC":
                // channel, topic, nick
                self.emit('topic', message.args[0], message.args[1], message.nick, message);
                break;
            case "rpl_channelmodeis":
                self.emit('mode', message.args[1], message.args[2], message);
                break;
            case "329":
                self.emit('created', message.args[1], message.args[2], message);
                break;
            case "JOIN":
                self.emit('join', message.args[0], message.nick, message);
                self.emit('join' + message.args[0], message.nick, message);
                if ( message.args[0] != message.args[0].toLowerCase() ) {
                    self.emit('join' + message.args[0].toLowerCase(), message.nick, message);
                }
                break;
            case "PART":
                // channel, who, reason
                self.emit('part', message.args[0], message.nick, message.args[1], message);
                self.emit('part' + message.args[0], message.nick, message.args[1], message);
                if ( message.args[0] != message.args[0].toLowerCase() ) {
                    self.emit('part' + message.args[0].toLowerCase(), message.nick, message.args[1], message);
                }
                break;
            case "KICK":
                // channel, who, by, reason
                self.emit('kick', message.args[0], message.args[1], message.nick, message.args[2], message);
                self.emit('kick' + message.args[0], message.args[1], message.nick, message.args[2], message);
                if ( message.args[0] != message.args[0].toLowerCase() ) {
                    self.emit('kick' + message.args[0].toLowerCase(), message.args[1], message.nick, message.args[2], message);
                }
                break;
            case "KILL":
                self.emit('kill', message.args[0], message.args[1], message);
                break;
            case "PRIVMSG":
                var from = message.nick;
                var to   = message.args[0];
                var text = message.args[1];

                if ((typeof from) === 'undefined') {
                    from = message.server.split('!')[0];
                }

                if (text && text[0] === '\1' && text.lastIndexOf('\1') > 0) {
                    self._handleCTCP(from, to, text, 'privmsg');
                    break;
                }
                self.emit('message', from, to, text, message);
                if ( to.match(/^[&#]/) ) {
                    self.emit('message#', from, to, text, message);
                    self.emit('message' + to, from, text, message);
                    if ( to != to.toLowerCase() ) {
                        self.emit('message' + to.toLowerCase(), from, text, message);
                    }
                }
                if ( to == self.nick ) self.emit('pm', from, text, message);

                break;
            case "INVITE":
                var from = message.nick;
                var to   = message.args[0];
                var channel = message.args[1];
                self.emit('invite', channel, from, message);
                break;
            case "QUIT":
                if ( self.nick == message.nick ) {
                    // TODO handle?
                    self.emit('selfQuit', message.args[0]);
                    break;
                }
                // handle other people quitting
                // who, reason
                self.emit('quit', message.nick, message.args[0], message);
                break;
            case "ERROR":
                self.emit('error', message);
                break;
            case "err_umodeunknownflag":
                if ( self.opt.showErrors )
                    log.error("ERROR: " + util.inspect(message));
                break;
            default:
                if ( message.commandType == 'error' ) {
                    self.emit('error', message);
                    if ( self.opt.showErrors )
                        log.error("ERROR: " + util.inspect(message));
                }
                else {
                    log.warn("Unhandled message: " + util.inspect(message));
                }
                break;
        }
    });

    process.EventEmitter.call(this);
}

util.inherits(Client, process.EventEmitter);

Client.prototype.conn = null;
Client.prototype.prefixForMode = {};
Client.prototype.modeForPrefix = {};
Client.prototype.connect = function ( retryCount, callback ) {
    var self = this;

    if (self.conn && self.conn.readyState != 'closed') {
        log.warn('ignored attempt to connect when already connected! ' + self.conn.readyState);
        return;
    }

    if ( typeof(retryCount) === 'function' ) {
        callback = retryCount;
        retryCount = undefined;
    }
    retryCount = retryCount || 0;
    if (typeof(callback) === 'function') {
      this.once('registered', callback);
    }
    // try to connect to the server
    self.emit('connecting');
    if (self.opt.secure) {

        var options = {
            rejectUnauthorized: false
        };

        self.conn = tls.connect(self.opt.port, self.opt.server, options, function() {
            if (self.conn.authorized) {
                self.finishConnecting();
                return;
            }

            function fail() {
                self.disconnect();
                self.emit('netError', self.conn.authorizationError);
                log.error('TLS auth error: ' + self.conn.authorizationError);
            }

            var allowedErrors = [ 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED' ];
            if (!_.include(allowedErrors, self.conn.authorizationError)) {
                fail();
                return;
            }

            // Let the user decide about this certificate.
            log.warn('Certificate needs manual trust: ' + self.conn.authorizationError);
            self.emit('invalidCert', self.conn.getPeerCertificate(), self.conn.authorizationError, function (accept) {
                if (accept) {
                    self.finishConnecting();
                } else {
                    fail();
                }
            });
        });
    } else {
        self.conn = net.createConnection(self.opt.port, self.opt.server);
        self.conn.addListener("connect", function () {
            self.finishConnecting.apply(self);
        });
    }
    self.conn.requestedDisconnect = false;
    self.conn.setTimeout(0);
    self.conn.setEncoding('utf8');

    self.conn.addListener("end", function() {
        log.debug('Connection got "end" event');
    });

    self.conn.addListener("close", function() {
        self.emit('close');
        log.debug('Connection got "close" event');
        if ( self.conn.requestedDisconnect )
            return;
        log.debug('Disconnected: reconnecting');
        if ( self.opt.retryCount !== null && retryCount >= self.opt.retryCount ) {
            log.debug( 'Maximum retry count (' + self.opt.retryCount + ') reached. Aborting' );
            self.emit( 'abort', self.opt.retryCount );
            return;
        }

        log.debug( 'Waiting ' + self.opt.retryDelay + 'ms before retrying' );
        self.retryTimeout = setTimeout( function() {
            log.debug('retry timeout!');
            self.retryTimeout = null;
            self.connect( retryCount + 1 );
        }, self.opt.retryDelay );
    });

    self.conn.addListener("error", function(exception) {
        log.debug('Connection got "error" event ' + exception);
        self.emit("netError", exception);
        self.conn.destroy();
    });
};
Client.prototype.finishConnecting = function () {
    var self = this;

    var my_carrier = carrier.carry(self.conn);
    my_carrier.on('line',  function(line) {
        self.emit('recvLine', line);
        var message = parseMessage(line, self.opt.stripColors);
        try {
            self.emit('raw', message);
        } catch ( err ) {
            if ( !self.conn.requestedDisconnect ) {
                log.error('UNCAUGHT ERROR FOR: ' + line);
                self.emit('error', err);
            }
        }
    });

    if (self.opt.password) {
        self.send( "PASS", self.opt.password );
    }
	
	if (self.opt.cloakUser && self.opt.cloakPasswd && self.opt.ircvHost) {
		self.send("WEBIRC", self.opt.cloakUser, self.opt.cloakPasswd, self.opt.ircvHost, '127.0.0.1');
	}
	
    self.send("NICK", self.opt.nick);
    self.nick = self.opt.nick;
    self.send("USER", self.opt.userName, 8, "*", self.opt.realName);
    self.emit("connect");
};
Client.prototype.disconnect = function ( message, callback ) {
    var self = this;

    log.debug('client disconnect');

    self.stopHeartbeat();

    if (self.retryTimeout) {
      log.debug('clearing retry timeout');
      clearTimeout(self.retryTimeout);
      self.retryTimeout = null;
    }

    if ( typeof(message) === 'function' ) {
        callback = message;
        message = undefined;
    }

    if (!self.conn) {
        log.debug('disconnect called when no conn');
        if (typeof(callback) === 'function') {
            callback();
        }
        return;
    }

    self.conn.requestedDisconnect = true;
    message = message || "node-irc says goodbye";
    if ( self.conn.readyState == 'open' ) {
        // FIXME: self.conn.destroy() might close socket before
        // this has a chance to send?
        self.send( "QUIT", message );
    }
    self.conn.destroy();
    if (typeof(callback) === 'function') {
        callback();
    }
    log.debug('CALLED DESTROY');
};
Client.prototype.send = function(command) {
    var args = [];
    for ( var k in arguments )
        args.push(arguments[k]);
    args[args.length-1] = ":" + args[args.length-1];

    // Remove the command
    args.shift();

    var commandText = command + " " + args.join(" ");
    if ( ! this.conn.requestedDisconnect ) {
        this.emit('sendLine', commandText);
        this.conn.write(commandText + "\r\n");
    }
};
Client.prototype.activateFloodProtection = function(interval) {

    var cmdQueue = [],
        safeInterval = interval || this.opt.floodProtectionDelay,
        self = this,
        origSend = this.send,
        dequeue;

    // Wrapper for the original function. Just put everything to on central
    // queue.
    this.send = function() {
        cmdQueue.push(arguments);
    };

    dequeue = function() {
        var args = cmdQueue.shift();
        if (args) {
            origSend.apply(self, args);
        }
    };

    // Slowly unpack the queue without flooding.
    setInterval(dequeue, safeInterval);
    dequeue();


};
Client.prototype.join = function(channel, callback) {
    this.once('join' + channel, function () {
        if ( typeof(callback) == 'function' ) {
            return callback.apply(this, arguments);
        }
    });
    this.send.apply(this, ['JOIN'].concat(channel.split(' ')));
};
Client.prototype.part = function(channel, callback) {
    if ( typeof(callback) == 'function' ) {
        this.once('part' + channel, callback);
    }
    this.send('PART', channel);
};
Client.prototype.say = function(target, text) {
    var self = this;
    if (typeof text !== 'undefined') {
        text.toString().split(/\r?\n/).filter(function(line) {
            return line.length > 0;
        }).forEach(function(line) {
            self.send('PRIVMSG', target, line);
            self.emit('selfMessage', target, line);
        });
    }
};
Client.prototype.action = function(channel, text) {
    var self = this;
    if (typeof text !== 'undefined') {
        text.toString().split(/\r?\n/).filter(function(line) {
            return line.length > 0;
        }).forEach(function(line) {
            self.send('PRIVMSG', channel, '\u0001ACTION ' + line + '\u0001');
            self.emit('selfAction', channel, line);
        });
    }
};
Client.prototype.notice = function(target, text) {
    this.send('NOTICE', target, text);
};
Client.prototype.whois = function(nick, callback) {
    if ( typeof callback === 'function' ) {
        var callbackWrapper = function(info) {
            if ( info.nick == nick ) {
                this.removeListener('whois', callbackWrapper);
                return callback.apply(this, arguments);
            }
        };
        this.addListener('whois', callbackWrapper);
    }
    this.send('WHOIS', nick);
};
Client.prototype.list = function() {
    var args = Array.prototype.slice.call(arguments, 0);
    args.unshift('LIST');
    this.send.apply(this, args);
};
Client.prototype._addWhoisData = function(nick, key, value, onlyIfExists) {
    if ( onlyIfExists && !this._whoisData[nick] ) return;
    this._whoisData[nick] = this._whoisData[nick] || {nick: nick};
    this._whoisData[nick][key] = value;
};
Client.prototype._clearWhoisData = function(nick) {
    var data = this._whoisData[nick];
    delete this._whoisData[nick];
    return data;
};
Client.prototype._handleCTCP = function(from, to, text, type) {
    text = text.slice(1);
    text = text.slice(0, text.indexOf('\1'));
    var parts = text.split(' ');
    this.emit('ctcp', from, to, text, type);
    this.emit('ctcp-'+type, from, to, text);
    if (type === 'privmsg' && text === 'VERSION')
        this.emit('ctcp-version', from, to);
    if (parts[0] === 'ACTION' && parts.length > 1)
        this.emit('action', from, to, parts.slice(1).join(' '));
    if (parts[0] === 'PING' && type === 'privmsg' && parts.length > 1)
        this.ctcp(from, 'notice', text);
};
Client.prototype.ctcp = function(to, type, text) {
    return this[type === 'privmsg' ? 'say' : 'notice'](to, '\1'+text+'\1');
};

Client.prototype.startHeartbeat = function () {
    var self = this;
    self.stopHeartbeat();
    self.heartbeatTimeout = setInterval(function () {
        self.send('PING ' + self.hostname);
        self.startPingTimeout(); // Expect a PONG sometime soon.
    }, 120000);
};
Client.prototype.stopHeartbeat = function () {
    var self = this;
    if (self.heartbeatTimeout) {
        clearTimeout(self.heartbeatTimeout);
        self.heartbeatTimeout = null;
    }
};
Client.prototype.startPingTimeout = function() {
    var self = this;
    self.stopPingTimeout();
    self.pingTimeout = setTimeout(function () {
        self.pingTimeout = null;
        self.emit('netError', 'ping timeout, reconnecting');
        self.conn.destroy();
    }, 30000);
};
Client.prototype.stopPingTimeout = function() {
    var self = this;
    if (self.pingTimeout) {
        clearTimeout(self.pingTimeout);
        self.pingTimeout = null;
    }
};

/*
 * parseMessage(line, stripColors)
 *
 * takes a raw "line" from the IRC server and turns it into an object with
 * useful keys
 */
function parseMessage(line, stripColors) {
    var message = {};
    var match;

    if (stripColors) {
        line = line.replace(/[\x02\x1f\x16\x0f]|\x03\d{0,2}(?:,\d{0,2})?/g, "");
    }

    // Parse prefix
    if ( match = line.match(/^:([^ ]+) +/) ) {
        message.prefix = match[1];
        line = line.replace(/^:[^ ]+ +/, '');
        if ( match = message.prefix.match(/^([_a-zA-Z0-9\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/) ) {
            message.nick = match[1];
            message.user = match[3];
            message.host = match[4];
        }
        else {
            message.server = message.prefix;
        }
    }

    // Parse command
    match = line.match(/^([^ ]+) */);
    message.command = match[1];
    message.rawCommand = match[1];
    message.commandType = 'normal';
    line = line.replace(/^[^ ]+ +/, '');

    if ( replyFor[message.rawCommand] ) {
        message.command     = replyFor[message.rawCommand].name;
        message.commandType = replyFor[message.rawCommand].type;
    }

    message.args = [];
    var middle, trailing;

    // Parse parameters
    if ( line.indexOf(':') != -1 ) {
        var index = line.indexOf(':');
        middle = line.substr(0, index).replace(/ +$/, "");
        trailing = line.substr(index+1);
    }
    else {
        middle = line;
    }

    if ( middle.length )
        message.args = middle.split(/ +/);

    if ( typeof(trailing) != 'undefined' && trailing.length )
        message.args.push(trailing);

    return message;
}
