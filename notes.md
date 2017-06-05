# Notes

## Generating a token for application

You need:

client-id: tdb85Rcx5sESf9p6
client-secret: 83e0d77a2f264ef0b81c80abef9c61d1

```
https://www.arcgis.com/sharing/oauth2/token?grant_type=client_credentials&f=json&client_id={client-id}&client_secret={client-secret}
```

Response:

```
{
    "access_token":"H9u5TwbUXyCHCjbsTX-0wKG6ya_tuyBl23QeYdcQtbhormiaiOEAZny4EjUxekMId6tnq9esrqxDAMOrt4VeYhABuUdocKM0oH589yJGwE9CPz-NLdb0avHVbb2u0SNG620JQuXHzJgsCXrge0YQmA..",
    "expires_in":7200
}
```

## Generating a token for named user

You need:

user-id: 
password: 

POST to

```
https://www.arcgis.com/sharing/oauth2/authorize
client_id={client-id}
response_type=code
expiration=7200
redirect_uri={}
```

Response:

```
{
    "access_token":"H9u5TwbUXyCHCjbsTX-0wKG6ya_tuyBl23QeYdcQtbhormiaiOEAZny4EjUxekMId6tnq9esrqxDAMOrt4VeYhABuUdocKM0oH589yJGwE9CPz-NLdb0avHVbb2u0SNG620JQuXHzJgsCXrge0YQmA..",
    "expires_in":7200
}
```
