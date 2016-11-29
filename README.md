# node.js ArcGIS Proxy Server
This is an implementation of an ArcGIS proxy server using node.js. While this server can proxy most http requests, it is specifically designed to act on behalf of ArcGIS type services following the [ArcGIS Resource Proxy](https://github.com/Esri/resource-proxy/) specification. The proxy handles support for:

* Accessing cross domain resources.
* Requests that exceed 2048 characters.
* Accessing resources secured with ArcGIS token based authentication.
* [OAuth 2.0 app login](https://developers.arcgis.com/en/authentication).
* Transaction logging.
* Both resource and referrer based rate limiting.

## Instructions

* Download and unzip the .zip file or clone this repository. You can download [a released version](https://github.com/Esri/resource-proxy/releases) (recommended) or the [most recent daily build](https://github.com/Esri/resource-proxy/archive/master.zip).
* install the node.js dependencies:

```
npm install
```

* Edit the proxy configuration file:
  * Choose either one of (conf/config.json or conf/config.xml) configuration format.
  * Use a text editor to set up your proxy configuration settings.
  * Decide which port your server should run on (default is 3692).
  * Determine which URLs you are going to proxy.
  * Review the full documentation for [proxy configuration settings](../README.md#proxy-configuration-settings).
* Start the node server from a command line.

```
npm start
```

* Test that the proxy is installed and available by running a browser on the local machine then navigate to the port and url:

```
http://localhost:{port}/ping
```

* Test that the proxy is able to forward requests directly in the browser using:

```
http://localhost:{port}/proxy/http/services.arcgisonline.com/ArcGIS/rest/services/?f=pjson
```

* Check the current status of your proxy server:

```
http://localhost:{port}/status
```

Once you deploy to an infrastructure on the public internet replace `localhost` with the host name you install the proxy server on.

## Folders and Files

The proxy consists of the following files:
* `package.json`: the node configuration.
* `conf/config.json`: This file contains the [configuration settings for the proxy](../README.md#proxy-configuration-settings). This is where you define all the resources that are allowed to use the proxy.
* `conf/config.xml`: This file contains the [configuration settings for the proxy](../README.md#proxy-configuration-settings). This is where you define all the resources that are allowed to use the proxy.
* `node_modules/`: after you run `npm install` this folder holds all the node dependencies.
* `bin/`: folder containing the proxy runtime scripts

## Requirements

* node.js version 6.0 or higher (recommended.)
* sudo access rights so you can install files, open a TCP/IP port.
* file access read/write access for the log file and the sqlite database.
* server administration and networking background to securely run your server.

### Example Configurations

The node proxy supports JSON and XML configuration. Sample configurations are located in the `/conf` folder.

If you change the configuration file you must restart the server.

### Requests

To properly use this proxy server in a secure manner you must white-list all requests. See the documentation regarding `allowedReferrers`. The
samples use `*` because we don't know where you are calling the proxy server from, but this is very dangerous. Do not deploy to production without
white-listing allowed referrers or you could end up proxying nefarious requests.

### Rate Limiting

You can set up rate limits on your proxied resources. This is the rate a resource may be accessed within the given time period for all referrers (requests).
For example, a `rateLimit` of 120 requests within a `rateLimitPeriod` of 60 minutes specifies no more than 120 requests over the course of 1 hour, or 2 requests per minute.
This is a sliding time window from the first request. Once the limit is reached access will not be granted until the next time interval.

## Issues

Found a bug or want to request a new feature? Check out previously logged [Issues](https://github.com/Esri/resource-proxy/issues) and/or our [FAQ](FAQ.md).  If you don't see what you're looking for, feel free to submit a [new issue](https://github.com/Esri/resource-proxy/issues/new).

## Contributing

Esri welcomes [contributions](CONTRIBUTING.md) from anyone and everyone. Please see our [guidelines for contributing](https://github.com/esri/contributing).

## License

Copyright 2016 Esri

Licensed under the Apache License, Version 2.0 (the "License");
You may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for specific language governing permissions and limitations under the license.
