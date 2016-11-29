# TO DO

1. serve file
1. remove test URLs from configs
2. clean configs to a default version


# node.js ArcGIS Proxy Server
This is an implementation of an ArcGIS proxy server using node.js. While this server can proxy most http requests, it is specifically designed to act on behalf of ArcGIS type services following the [ArcGIS Resource Proxy](https://github.com/Esri/resource-proxy/) specification. The proxy handles support for:

* Accessing cross domain resources.
* Requests that exceed 2048 characters.
* Accessing resources secured with ArcGIS token based authentication.
* [OAuth 2.0 app login](https://developers.arcgis.com/en/authentication).
* Transaction logging.
* Both resource and referrer based rate limiting.

## Instructions

* Download and unzip the .zip file or clone the repository. You can download [a released version](https://github.com/Esri/resource-proxy/releases) (recommended) or the [most recent daily build](https://github.com/Esri/resource-proxy/archive/master.zip).
* install the node.js dependencies:

```
npm install
```

* Edit the proxy configuration file (config.json or config.xml) in a text editor to set up your [proxy configuration settings](../README.md#proxy-configuration-settings).
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

* node.js version 6.0 or higher (recommended)
* sudo access rights so you can install files, open a TCP/IP port
* file access read/write access for the log file and the sqlite database.
* server administration and networking background to securly run your server.

### Example Configurations

The node proxy supports JSON and XML configuration.

If you change the configuration file you must restart the server.
