targetScope = 'resourceGroup'

extension microsoftGraphV1

@minLength(1)
@maxLength(50)
param environmentName string

@description('Immutable adoption key; use the existing application uniqueName when already assigned.')
param gatewayApplicationUniqueName string = '${subscription().subscriptionId}-${environmentName}-agentgateway'

param promptApplicationUniqueName string = '${subscription().subscriptionId}-${environmentName}-prompt-gateway'

@description('Preserve the existing gateway.invoke ID when adopting an application.')
param gatewayInvokeScopeId string = guid(subscription().subscriptionId, environmentName, 'gateway.invoke')

@description('Existing API settings retained during adoption and subsequent updates.')
param existingGatewayApi object = {}

param existingGatewayOptionalClaims object = {}

param existingGatewayIdentifierUris string[] = []

var gatewayApi = union(existingGatewayApi, {
  requestedAccessTokenVersion: 2
  oauth2PermissionScopes: concat(
    filter(existingGatewayApi.?oauth2PermissionScopes ?? [], scope => scope.value != 'gateway.invoke'),
    [
      {
        id: gatewayInvokeScopeId
        value: 'gateway.invoke'
        type: 'User'
        isEnabled: true
        adminConsentDisplayName: 'Invoke agentgateway'
        adminConsentDescription: 'Invoke models through agentgateway as the signed-in user.'
        userConsentDisplayName: 'Invoke agentgateway'
        userConsentDescription: 'Invoke models through agentgateway as you.'
      }
    ]
  )
})

resource gatewayApplication 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: gatewayApplicationUniqueName
  displayName: '${environmentName}-agentgateway'
  signInAudience: 'AzureADMyOrg'
  api: gatewayApi
  optionalClaims: union(existingGatewayOptionalClaims, {
    accessToken: concat(
      filter(existingGatewayOptionalClaims.?accessToken ?? [], claim => claim.name != 'idtyp'),
      [
        {
          name: 'idtyp'
          essential: false
        }
      ]
    )
  })
}

// The generated appId and enabled scope must exist before configuring the API URI and preauthorization.
module gatewayApiConfiguration './modules/gateway-entra-api.bicep' = {
  name: 'gateway-entra-api-${uniqueString(gatewayApplicationUniqueName)}'
  params: {
    applicationUniqueName: gatewayApplicationUniqueName
    applicationClientId: gatewayApplication.appId
    applicationDisplayName: '${environmentName}-agentgateway'
    invokeScopeId: gatewayInvokeScopeId
    api: gatewayApi
    identifierUris: existingGatewayIdentifierUris
  }
}

resource gatewayPrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: gatewayApplication.appId
}

resource promptApplication 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: promptApplicationUniqueName
  displayName: '${environmentName}-prompt-gateway'
  signInAudience: 'AzureADMyOrg'
}

resource promptPrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: promptApplication.appId
}

output gatewayClientId string = gatewayApplication.appId
output gatewayPrincipalId string = gatewayPrincipal.id
output invokeScopeId string = gatewayInvokeScopeId
output promptClientId string = promptApplication.appId
output promptPrincipalId string = promptPrincipal.id
