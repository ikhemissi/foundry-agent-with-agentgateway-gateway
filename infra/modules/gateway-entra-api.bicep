targetScope = 'resourceGroup'

extension microsoftGraphV1

param applicationUniqueName string
param applicationClientId string
param applicationDisplayName string
param invokeScopeId string
param api object
param identifierUris string[]

var cliClientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'
var existingCli = filter(api.?preAuthorizedApplications ?? [], client => client.appId == cliClientId)

resource application 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: applicationUniqueName
  displayName: applicationDisplayName
  identifierUris: union(identifierUris, ['api://${applicationClientId}'])
  api: union(api, {
    preAuthorizedApplications: concat(
      filter(api.?preAuthorizedApplications ?? [], client => client.appId != cliClientId),
      [
        {
          appId: cliClientId
          delegatedPermissionIds: union(
            empty(existingCli) ? [] : existingCli[0].delegatedPermissionIds,
            [invokeScopeId]
          )
        }
      ]
    )
  })
}
