/**
 * Configuration file parser, validator, and accessor. Calling loadConfigurationFile returns a promise that will
 * resolve once the config is loaded, parsed, and validated.
 *
 * See README for the configuration file format.
 */

const fs = require('fs');
const joinPath = require('path.join');
const loadJsonFile = require('load-json-file');
const ProjectUtilities = require('./ProjectUtilities');
const QuickLogger = require('./QuickLogger');
const UrlFlexParser = require('./UrlFlexParser');
const xml2js = require('xml2js');

const defaultConfigurationFilePath = 'conf';
const defaultConfigurationFileName = 'config';
const defaultConfigurationFileType = 'xml';
const defaultOAuthEndpoint = 'https://www.arcgis.com/sharing/oauth2/';

var configuration = {
    mustMatch: true,
    logLevel: QuickLogger.LOGLEVEL.ERROR.value,
    logConsole: true,
    logFunction: null,
    localPingURL: '/ping',
    localStatusURL: '/status',
    port: 3333, // 80
    useHTTPS: false,
    httpsKeyFile: null,
    httpsCertificateFile: null,
    httpsPfxFile: null,
    listenURI: null,
    allowedReferrers: ['*'],
    allowAnyReferrer: false,
    serverURLs: []
};
var configurationComplete = false;

/**
 * Return true if the server URL definition for this resource is to support user login (user name+password). We use this to
 * get the secure token.
 * @param serverURLInfo {object} the server URL definition to check.
 * @returns {boolean}
 */
function isUserLogin (serverURLInfo) {
    if (serverURLInfo != null) {
        return serverURLInfo.username !== undefined && serverURLInfo.username.trim().length > 0 && serverURLInfo.password !== undefined && serverURLInfo.password.trim().length > 0;
    } else {
        return false;
    }
}

/**
 * Return true if the server URL definition for this resource is to support app login (clientId). We use this to
 * get the secure token with OAuth.
 * @param serverURLInfo {object} the server URL definition to check.
 * @returns {boolean}
 */
function isAppLogin (serverURLInfo) {
    if (serverURLInfo != null) {
        return serverURLInfo.clientid !== undefined && serverURLInfo.clientid.trim().length > 0 && serverURLInfo.clientsecret !== undefined && serverURLInfo.clientsecret.trim().length > 0;
    } else {
        return false;
    }
}

/**
 * Determine if the configuration is valid enough to start the server. If it is not valid any reasons are
 * written to the log file and the server is not started.
 * @returns {boolean} true if valid enough.
 */
function isConfigurationValid () {
    var isValid,
        serverUrl,
        i;

    // allowedReferrers != empty
    // port >= 80 <= 65535
    // either httpsKeyFile && httpsCertificateFile or httpsPfxFile
    // at least one serverUrls
    isValid = QuickLogger.setConfiguration(configuration);
    if (configuration.listenURI == null) {
        QuickLogger.logErrorEvent('No URI was set to listen for. Indicate a URI path on your server, for example /proxy');
        isValid = false;
    } else if (configuration.listenURI.length == 0) {
        QuickLogger.logErrorEvent('No URI was set to listen for. Indicate a URI path on your server, for example /proxy');
        isValid = false;
    }
    if (configuration.serverUrls == null) {
        QuickLogger.logErrorEvent('You must configure serverUrls.');
        isValid = false;
    } else if (configuration.serverUrls.length == 0) {
        QuickLogger.logErrorEvent('You must configure serverUrls for at least one service.');
        isValid = false;
    } else {
        for (i = 0; i < configuration.serverUrls.length; i ++) {
            serverUrl = configuration.serverUrls[i];
            if (serverUrl.errorMessage != '') {
                isValid = false;
                QuickLogger.logErrorEvent('Error(s) in the server URL definitions for ' + serverUrl.url + ': ' + serverUrl.errorMessage);
            }
        }
    }
    // TODO: We do not validate the individual server URLs but maybe we should?
    if (configuration.allowedReferrers == null) {
        configuration.allowedReferrers = ['*'];
        QuickLogger.logWarnEvent('You should configure allowedReferrers to at least one referrer, use ["*"] to accept all connections. Defaulting to ["*"].');
    } else if (configuration.allowedReferrers.length == 0) {
        configuration.allowedReferrers = ['*'];
        QuickLogger.logWarnEvent('You should configure allowedReferrers to at least one referrer, use ["*"] to accept all connections. Defaulting to ["*"].');
    }
    return isValid;
}

/**
 * After we load and parse the configuration file we go through every attribute and attempt to
 * validate the data, normalize the data, and pre-cache certain values to reduce stress at runtime.
 * This function does not return anything, it updates the configuration data structure in-place.
 * Use isConfigurationValid() after this function to validate the configuration is good enough to start with.
 * @param json {object} - the object we are parsing and validating.
 * @param schema {string} - indicates which configuration schema we loaded, either 'json' or 'xml'
 */
function postParseConfigurationFile(json, schema) {
    var proxyConfigSection,
        serverUrlsSection,
        allowedReferrersSection,
        allowedReferrers,
        referrerToCheckParts,
        referrerValidated,
        serverUrls,
        serverUrl,
        urlParts,
        logLevel,
        i,
        invalidSetting;

    if (json !== null) {
        if (schema == 'json') {
            proxyConfigSection = json.ProxyConfig;
            if (proxyConfigSection === undefined) {
                proxyConfigSection = json.proxyConfig;
            } else {
                proxyConfigSection = null;
            }
        } else if (schema === 'xml') {
            proxyConfigSection = json.ProxyConfig['$'];
        } else {
            proxyConfigSection = null;
        }
        if (proxyConfigSection !== undefined && proxyConfigSection !== undefined) {
            if (proxyConfigSection.useHTTPS !== undefined) {
                if (typeof proxyConfigSection.useHTTPS === 'string') {
                    configuration.useHTTPS = proxyConfigSection.useHTTPS.toLocaleLowerCase().trim() === 'true' || proxyConfigSection.useHTTPS === '1';
                } else {
                    configuration.useHTTPS = proxyConfigSection.useHTTPS;
                }
            }
            if (proxyConfigSection.port !== undefined) {
                if (typeof proxyConfigSection.port === 'string') {
                    configuration.port = parseInt(proxyConfigSection.port, 10);
                } else {
                    configuration.port = proxyConfigSection.port;
                }
            }
            if (proxyConfigSection.mustMatch !== undefined) {
                if (typeof proxyConfigSection.mustMatch === 'string') {
                    configuration.mustMatch = proxyConfigSection.mustMatch.toLocaleLowerCase().trim() === 'true' || proxyConfigSection.mustMatch === '1';
                } else {
                    configuration.mustMatch = proxyConfigSection.mustMatch;
                }
            } else {
                configuration.mustMatch = true;
            }
            if (proxyConfigSection.matchAllReferrer !== undefined) {
                if (typeof proxyConfigSection.matchAllReferrer === 'string') {
                    configuration.matchAllReferrer = proxyConfigSection.matchAllReferrer.toLocaleLowerCase().trim() === 'true' || proxyConfigSection.matchAllReferrer === '1';
                } else {
                    configuration.matchAllReferrer = proxyConfigSection.matchAllReferrer;
                }
            } else {
                configuration.matchAllReferrer = true;
            }
            if (proxyConfigSection.logToConsole !== undefined) {
                if (typeof proxyConfigSection.logToConsole === 'string') {
                    configuration.logToConsole = proxyConfigSection.logToConsole.toLocaleLowerCase().trim() === 'true' || proxyConfigSection.logToConsole === '1';
                } else {
                    configuration.logToConsole = proxyConfigSection.logToConsole == true;
                }
            } else {
                configuration.logToConsole = false;
            }
            if (proxyConfigSection.logFile !== undefined) {
                configuration.logFileName = proxyConfigSection.logFile;
            } else if (proxyConfigSection.logFileName !== undefined) {
                configuration.logFileName = proxyConfigSection.logFileName;
            }
            if (proxyConfigSection.logFilePath !== undefined) {
                configuration.logFilePath = proxyConfigSection.logFilePath;
            }
            if (proxyConfigSection.logLevel !== undefined) {
                invalidSetting = true;
                for (logLevel in QuickLogger.LOGLEVEL) {
                    if (QuickLogger.LOGLEVEL.hasOwnProperty(logLevel)) {
                        if (QuickLogger.LOGLEVEL[logLevel].label == proxyConfigSection.logLevel.toUpperCase()) {
                            configuration.logLevel = QuickLogger.LOGLEVEL[logLevel].value;
                            invalidSetting = false;
                            break;
                        }
                    }
                }
                if (invalidSetting) {
                    console.log('Undefined logging level ' + proxyConfigSection.logLevel + ' requested, logging level set to ERROR.');
                }
            } else {
                console.log('No logging level requested, logging level set to ERROR.');
            }
            // allowedReferrers can be a single string, items separated with comma, or an array of strings.
            // Make sure we end up with an array of strings.
            if (proxyConfigSection.allowedReferers !== undefined) {
                allowedReferrersSection = proxyConfigSection.allowedReferers;
            } else if (proxyConfigSection.allowedReferrers !== undefined) {
                allowedReferrersSection = proxyConfigSection.allowedReferrers;
            } else {
                allowedReferrersSection = null;
            }
            if (allowedReferrersSection !== null) {
                if (Array.isArray(allowedReferrersSection)) {
                    // create a new array from the existing array
                    allowedReferrers = allowedReferrersSection.slice();
                } else if (allowedReferrersSection.indexOf(',') >= 0) {
                    // create an array of the comma separated referrer list
                    allowedReferrers = allowedReferrersSection.split(',');
                } else {
                    // create a new array from a single string
                    allowedReferrers = [allowedReferrersSection];
                }
                // make a cache of the allowed referrers so checking at runtime is easier and avoids parsing the referrer on each lookup
                configuration.allowedReferrers = [];
                for (i = 0; i < allowedReferrers.length; i ++) {
                    referrerValidated = {
                        protocol: '*',
                        hostname: '*',
                        path: '*',
                        referrer: '*'
                    };
                    if (allowedReferrers[i] == "*") {
                        // TODO: this may not be necessary because when we match a * we don't check the individual parts
                        configuration.allowAnyReferrer = true;
                        configuration.allowedReferrers.push(referrerValidated);
                    } else {
                        referrerToCheckParts = UrlFlexParser.parseAndFixURLParts(allowedReferrers[i].toLowerCase().trim());
                        if (referrerToCheckParts.protocol != undefined) {
                            referrerValidated.protocol = referrerToCheckParts.protocol;
                        }
                        if (referrerToCheckParts.hostname != undefined) {
                            referrerValidated.hostname = referrerToCheckParts.hostname;
                            referrerValidated.path = referrerToCheckParts.path;
                        } else {
                            referrerValidated.hostname = referrerToCheckParts.path;
                        }
                        referrerValidated.referrer = UrlFlexParser.fullReferrerURLFromParts(referrerValidated); // used for the database key for this referrer match
                        configuration.allowedReferrers.push(referrerValidated);
                    }
                }
            }
            if (configuration.useHTTPS) {
                if (proxyConfigSection.httpsKeyFile !== undefined) {
                    configuration.httpsKeyFile = proxyConfigSection.httpsKeyFile;
                }
                if (proxyConfigSection.httpsCertificateFile !== undefined) {
                    configuration.httpsCertificateFile = proxyConfigSection.httpsCertificateFile;
                }
                if (proxyConfigSection.httpsPfxFile !== undefined) {
                    configuration.httpsPfxFile = proxyConfigSection.httpsPfxFile;
                }
            }
            // listenURI can be a single string or an array of strings
            if (proxyConfigSection.listenURI !== undefined) {
                if (Array.isArray(proxyConfigSection.listenURI)) {
                    configuration.listenURI = proxyConfigSection.listenURI.slice();
                } else {
                    configuration.listenURI = [proxyConfigSection.listenURI];
                }
            }
            if (proxyConfigSection.pingPath !== undefined) {
                configuration.localPingURL = proxyConfigSection.pingPath;
            }
            if (proxyConfigSection.statusPath !== undefined) {
                configuration.localStatusURL = proxyConfigSection.statusPath;
            }
        }

        // serverURLs is an array of objects
        if (schema == 'json') {
            serverUrlsSection = json.ServerUrls;
            if (serverUrlsSection === undefined) {
                serverUrlsSection = json.serverUrls;
            } else {
                serverUrlsSection = null;
            }
        } else if (schema === 'xml') {
            serverUrlsSection = json.ProxyConfig.ServerUrls;
            if (serverUrlsSection === undefined) {
                serverUrlsSection = json.ProxyConfig.serverUrls;
            }
            if (serverUrlsSection !== undefined && Array.isArray(serverUrlsSection) && serverUrlsSection.length == 1) {
                serverUrlsSection = serverUrlsSection[0];
                if (serverUrlsSection.serverUrl !== undefined) {
                    serverUrlsSection = serverUrlsSection.serverUrl;
                } else if (serverUrlsSection.ServerUrl !== undefined) {
                    serverUrlsSection = serverUrlsSection.ServerUrl;
                }
            }
        } else {
            serverUrlsSection = null;
        }
        configuration.serverUrls = [];
        if (serverUrlsSection !== undefined && serverUrlsSection !== null) {
            if (Array.isArray(serverUrlsSection)) {
                serverUrls = serverUrlsSection.slice(); // if array copy the array
            } else {
                serverUrls = [serverUrlsSection]; // if single object make it an array of 1
            }
            // iterate the array of services and validate individual settings
            for (i = 0; i < serverUrls.length; i ++) {
                serverUrl = serverUrls[i];
                if (schema == 'xml' && serverUrl['$'] !== undefined) {
                    // the xml parser put attributes in a dummy object "$"
                    serverUrl = serverUrl['$'];
                } else if (schema == 'json' && serverUrl.serverUrl !== undefined) {
                    // if the config file uses the old format {serverUrls: { serverUrl: { ... }} then convert it to the newer format.
                    serverUrl = serverUrl.serverUrl;
                }
                serverUrl.errorMessage = '';
                urlParts = UrlFlexParser.parseAndFixURLParts(serverUrl.url);
                if (urlParts != null) {
                    serverUrl.protocol = urlParts.protocol;
                    serverUrl.hostname = urlParts.hostname;
                    serverUrl.path = urlParts.path;
                    serverUrl.port = urlParts.port;
                    serverUrl.query = urlParts.query;
                    if (serverUrl.protocol == null || serverUrl.protocol == '') {
                        serverUrl.protocol = '*';
                    }
                    if (serverUrl.protocol.charAt(serverUrl.protocol.length - 1) == ':') {
                        serverUrl.protocol = serverUrl.protocol.substr(0, serverUrl.protocol.length - 1);
                    }
                    if (serverUrl.hostname == null || serverUrl.hostname == '') {
                        serverUrl.hostname = serverUrl.path;
                        serverUrl.path = '*';
                    }
                    if (serverUrl.port == null || serverUrl.port == '') {
                        serverUrl.port = '*';
                    }
                }
                if (serverUrl.matchAll !== undefined) {
                    if (typeof serverUrl.matchAll === 'string') {
                        serverUrl.matchAll = serverUrl.matchAll.toLocaleLowerCase().trim() === 'true' || serverUrl.matchAll == '1';
                    }
                } else {
                    serverUrl.matchAll = true;
                }
                if (serverUrl.rateLimit !== undefined) {
                    serverUrl.rateLimit = parseInt(serverUrl.rateLimit);
                    if (serverUrl.rateLimit < 0) {
                        serverUrl.rateLimit = 0;
                    }
                } else {
                    serverUrl.rateLimit = 0;
                }
                if (serverUrl.rateLimitPeriod !== undefined) {
                    serverUrl.rateLimitPeriod = parseInt(serverUrl.rateLimitPeriod);
                    if (serverUrl.rateLimitPeriod < 0) {
                        serverUrl.rateLimitPeriod = 0;
                    }
                } else {
                    serverUrl.rateLimitPeriod = 0;
                }
                if (serverUrl.rateLimit > 0 && serverUrl.rateLimitPeriod > 0) {
                    serverUrl.useRateMeter = true;
                    serverUrl.rate = serverUrl.rateLimit / serverUrl.rateLimitPeriod / 60; // how many we give out per second
                    serverUrl.ratePeriodSeconds = 1 / serverUrl.rate; // how many seconds in 1 rate period
                } else {
                    serverUrl.useRateMeter = false;
                    serverUrl.rate = 0;
                    serverUrl.ratePeriodSeconds = 0;
                }
                if (serverUrl.hostRedirect !== undefined && serverUrl.hostRedirect.trim().length > 0) {
                    serverUrl.parsedHostRedirect = UrlFlexParser.parseAndFixURLParts(serverUrl.hostRedirect.trim());
                    serverUrl.isHostRedirect = true;
                } else {
                    serverUrl.isHostRedirect = false;
                }
                serverUrl.mayRequireToken = false;
                if (ProjectUtilities.isPropertySet(serverUrl, 'clientId') || ProjectUtilities.isPropertySet(serverUrl, 'clientSecret') || ProjectUtilities.isPropertySet(serverUrl, 'oauth2Endpoint')) {
                    serverUrl.clientId = ProjectUtilities.getIfPropertySet(serverUrl, 'clientId', '');
                    serverUrl.clientSecret = ProjectUtilities.getIfPropertySet(serverUrl, 'clientSecret', '');
                    serverUrl.oauth2Endpoint = ProjectUtilities.getIfPropertySet(serverUrl, 'oauth2Endpoint', defaultOAuthEndpoint);
                    if (serverUrl.clientId.length < 1 || serverUrl.clientSecret.length < 1 || serverUrl.oauth2Endpoint < 1) {
                        serverUrl.errorMessage = 'When using OAuth a setting for clientId, clientSecret, and oauth2Endpoint must all be provided. At least one is missing.';
                    }
                    if (serverUrl.oauth2Endpoint.charAt(serverUrl.oauth2Endpoint.length - 1) != '/') {
                        serverUrl.oauth2Endpoint += '/';
                    }
                }
                if (ProjectUtilities.isPropertySet(serverUrl, 'username') || ProjectUtilities.isPropertySet(serverUrl, 'password')) {
                    serverUrl.username = ProjectUtilities.getIfPropertySet(serverUrl, 'username', '');
                    serverUrl.password = ProjectUtilities.getIfPropertySet(serverUrl, 'password', '');
                    if (serverUrl.username.length < 1 || serverUrl.password.length < 1) {
                        serverUrl.errorMessage = 'When using username/password both must all be provided. At least one is missing.';
                    }
                }
                if (ProjectUtilities.isPropertySet(serverUrl, 'accessToken')) {
                    // todo: should we attempt to validate the token?
                    serverUrl.mayRequireToken = true;
                }
                serverUrl.isUserLogin = isUserLogin(serverUrl);
                serverUrl.isAppLogin = isAppLogin(serverUrl);
                serverUrl.mayRequireToken = serverUrl.mayRequireToken || serverUrl.isUserLogin || serverUrl.isAppLogin;
                serverUrl.totalRequests = 0;
                serverUrl.firstRequest = 0;
                serverUrl.lastRequest = 0;

                // TODO: Should we attempt to validate any of the following parameters?
                // domain;
                // tokenParamName;

                configuration.serverUrls.push(serverUrl);
            }
        }
    }
}

/**
 * Load the configuration file and process it by copying anything that looks valid into our
 * internal configuration object. This function loads asynchronously so it returns before the
 * file is loaded or processed.
 * @param configFile {string} path to the configuration file.
 */
function loadConfigurationFile (configFile) {
    var promise;

    promise = new Promise(function(resolvePromise, rejectPromise) {
        if (configFile == undefined || configFile == null || configFile.length == 0) {
            configFile = joinPath(defaultConfigurationFilePath, defaultConfigurationFileName);
            if (defaultConfigurationFileType != null && defaultConfigurationFilePath.length > 0) {
                configFile += '.' + defaultConfigurationFileType;
            }
        }
        QuickLogger.logInfoEvent('Loading configuration from ' + configFile);
        if (ProjectUtilities.isFileTypeJson(configFile)) {
            loadJsonFile(configFile).then(function (jsonObject) {
                postParseConfigurationFile(jsonObject, 'json');
                configurationComplete = true;
                if (isConfigurationValid()) {
                    resolvePromise();
                } else {
                    rejectPromise(new Error('Configuration file not valid, check log or error console for more information.'));
                }
            }, function (error) {
                QuickLogger.logErrorEvent('!!! Invalid configuration file format. ' + error.toString() + ' !!!');
            });
        } else {
            var xmlParser = new xml2js.Parser();
            fs.readFile(configFile, function(fileError, xmlData) {
                if (fileError == null) {
                    xmlParser.parseString(xmlData, function (xmlError, xmlObject) {
                        if (xmlError == null) {
                            postParseConfigurationFile(xmlObject, 'xml');
                            configurationComplete = true;
                            if (isConfigurationValid()) {
                                resolvePromise();
                            } else {
                                rejectPromise(new Error('Configuration file not valid, check log or error console for more information.'));
                            }
                        } else {
                            rejectPromise(xmlError);
                        }
                    });
                } else {
                    rejectPromise(fileError);
                }
            });
        }
    });
    return promise;
}

module.exports.configuration = configuration;
module.exports.isConfigurationValid = isConfigurationValid;
module.exports.loadConfigurationFile = loadConfigurationFile;

