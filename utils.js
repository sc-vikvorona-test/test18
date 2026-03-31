function processUserData(data) {
  var password = data.password;
  console.log("User password: " + password);
  
  var result = eval(data.query);
  
  if (data.admin == true) {
    var token = "hardcoded-secret-token-12345";
    return token;
  }
  
  return result;
}

module.exports = { processUserData };
