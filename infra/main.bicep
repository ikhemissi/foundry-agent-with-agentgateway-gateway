targetScope = 'subscription'

@minLength(1)
@maxLength(50)
@description('Name of the azd environment.')
param environmentName string

@description('Object ID of the human deploying the sample.')
param principalId string

@allowed([
  'eastus'
  'uksouth'
  'swedencentral'
])
param location string = 'eastus'

@secure()
@minLength(32)
@description('Gateway inference credential. Supply a random value through the process environment, not azd env set.')
param gatewayApiKey string

@minValue(1)
@description('GlobalStandard capacity in thousands of tokens per minute, subject to quota.')
param modelCapacity int = 10

@description('Pinned Linux amd64 gateway image verified by the compatibility tests.')
param gatewayImage string = 'cr.agentgateway.dev/agentgateway:v1.6.0@sha256:9d3e6044ddcdc0878b1787f77bd401252b95e22684203fb5e874c4c42d2ed90c'

param tags object = {}

var resourceTags = union(tags, {
  'azd-env-name': environmentName
})

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: resourceTags
}

var suffix = uniqueString(subscription().id, resourceGroup.id, 'agentgateway')

module resourceGroupAccess './modules/resource-group-access.bicep' = {
  name: 'resource-group-access'
  scope: resourceGroup
  params: {
    principalId: principalId
  }
}

module identity './modules/identity.bicep' = {
  name: 'gateway-identity'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
  }
}

module monitoring './modules/monitoring.bicep' = {
  name: 'shared-monitoring'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
    principalId: principalId
    gatewayPrincipalId: identity.outputs.principalId
  }
}

module sourceFoundry './modules/source-foundry.bicep' = {
  name: 'source-foundry'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
    principalId: principalId
    gatewayPrincipalId: identity.outputs.principalId
    modelCapacity: modelCapacity
    workspaceId: monitoring.outputs.workspaceId
  }
}

module consumerFoundry './modules/consumer-foundry.bicep' = {
  name: 'consumer-foundry'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
    principalId: principalId
    workspaceId: monitoring.outputs.workspaceId
  }
}

module keyVault './modules/key-vault.bicep' = {
  name: 'gateway-key-vault'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
    principalId: principalId
    gatewayPrincipalId: identity.outputs.principalId
    gatewayApiKey: gatewayApiKey
    workspaceId: monitoring.outputs.workspaceId
  }
}

module containerApps './modules/container-apps.bicep' = {
  name: 'gateway-container-apps'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
    gatewayImage: gatewayImage
    gatewayIdentityId: identity.outputs.id
    gatewayClientId: identity.outputs.clientId
    sourceAccountName: sourceFoundry.outputs.name
    apiKeySecretUri: keyVault.outputs.apiKeySecretUri
    workspaceId: monitoring.outputs.workspaceId
    appInsightsConnectionString: monitoring.outputs.connectionString
  }
}

module modelConnection './modules/model-connection.bicep' = {
  name: 'consumer-model-connection'
  scope: resourceGroup
  params: {
    consumerFoundryName: consumerFoundry.outputs.name
    consumerProjectName: consumerFoundry.outputs.projectName
    gatewayEndpoint: containerApps.outputs.endpoint
    gatewayApiKey: gatewayApiKey
    modelDeploymentName: sourceFoundry.outputs.modelDeploymentName
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AGENTGATEWAY_ENDPOINT string = containerApps.outputs.endpoint
output AGENTGATEWAY_CONTAINER_APP_NAME string = containerApps.outputs.name
output SOURCE_FOUNDRY_NAME string = sourceFoundry.outputs.name
output SOURCE_FOUNDRY_PROJECT_ENDPOINT string = sourceFoundry.outputs.projectEndpoint
output SOURCE_AZURE_OPENAI_RESOURCE_NAME string = sourceFoundry.outputs.name
output SOURCE_AZURE_OPENAI_ENDPOINT string = sourceFoundry.outputs.openAIEndpoint
output SOURCE_MODEL_DEPLOYMENT_NAME string = sourceFoundry.outputs.modelDeploymentName
output CONSUMER_FOUNDRY_NAME string = consumerFoundry.outputs.name
output CONSUMER_FOUNDRY_PROJECT_ENDPOINT string = consumerFoundry.outputs.projectEndpoint
output AZURE_AI_PROJECT_ID string = consumerFoundry.outputs.projectId
output AZURE_AI_PROJECT_ENDPOINT string = consumerFoundry.outputs.projectEndpoint
output AZURE_KEY_VAULT_NAME string = keyVault.outputs.name
output CONSUMER_MODEL_CONNECTION_NAME string = modelConnection.outputs.name
output CONSUMER_MODEL_REFERENCE string = modelConnection.outputs.modelReference
output APPLICATIONINSIGHTS_NAME string = monitoring.outputs.appInsightsName
output APPLICATIONINSIGHTS_RESOURCE_ID string = monitoring.outputs.appInsightsId
output APPLICATIONINSIGHTS_CONNECTION_STRING string = monitoring.outputs.connectionString
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = monitoring.outputs.workspaceId
