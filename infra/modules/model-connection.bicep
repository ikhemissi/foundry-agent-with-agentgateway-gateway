targetScope = 'resourceGroup'

param consumerFoundryName string
param consumerProjectName string
param gatewayEndpoint string
param modelDeploymentName string

param gatewayEntraClientId string
param promptGatewayClientId string

@secure()
@minLength(1)
param promptGatewayClientSecret string

var modelMetadata = {
  deploymentInPath: 'false'
  inferenceAPIVersion: ''
  models: string([
    {
      name: modelDeploymentName
      properties: {
        model: {
          name: 'gpt-5.4-nano'
          version: ''
          format: 'OpenAI'
        }
      }
    }
  ])
}

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: consumerFoundryName
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' existing = {
  parent: account
  name: consumerProjectName
}

#disable-next-line BCP081
resource connectionOAuth 'Microsoft.CognitiveServices/accounts/projects/connections@2026-09-01' = {
  parent: project
  name: 'agentgateway-gateway'
  properties: {
    category: 'ModelGateway'
    target: '${gatewayEndpoint}/entra/v1'
    authType: 'OAuth2'
    isSharedToAll: false
    metadata: modelMetadata
    credentials: {
      clientId: promptGatewayClientId
      clientSecret: promptGatewayClientSecret
    }
    tokenUrl: 'https://login.microsoftonline.com/${tenant().tenantId}/oauth2/v2.0/token'
    scopes: ['api://${gatewayEntraClientId}/.default']
  }
}

output name string = 'agentgateway-gateway'
output modelReference string = 'agentgateway-gateway/${modelDeploymentName}'
