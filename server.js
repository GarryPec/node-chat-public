var app = require('express')();
var express = require('express');
var http = require('http').Server(app);
var io = require('socket.io')(http);
var fs = require('fs');
var mysql = require('mysql');
var validator = require('validator');
var siofu = require("socketio-file-upload");
var request = require('request');

//Image uploading
app.use(siofu.router);

var maxImageSize = 150; //150kb

//Globals:

var connections = [];
var channels = [];

var version = "v1.0";

//list of words that can't appear in usernames/channel names...  loaded from filter.txt
var filterList = fs.readFileSync(process.cwd() + '/filter.txt').toString().split("\r\n");

//SQL Stuff:
var listenPort = 80;
var poolConfig = {
    connectionLimit : 50, //important
    host     : 'localhost',
    user     : 'root',
    password : '',
    port : '3306',
    database : 'chat',
    debug    :  false
};
if (process.env.NODE_DEBUG && process.env.NODE_DEBUG == 'true') {
    poolConfig.password = 'tr41n1ng';
    poolConfig.port = '3306';
    listenPort = 3000;
}
var pool      =    mysql.createPool(poolConfig);

function handle_database_login(con, msg)
{
    var password = sha1hash(msg.password);
    var nickname = msg.nickname;
    pool.getConnection(function(err,connection){
	
        if (err) {
          connection.release();
          console.log("database error: " + err);
        }
       
        connection.query("select * from users where nickname='" + nickname + "' AND passwordHash='" + password + "';",function(err,rows){
            connection.release();
            if(!err) {
			
                if(rows.length == 1)
				{
					simpleQueryCallBack("select * from serverbans where nickname='" + nickname + "';", function(banRows)
					{
						if(banRows.length == 0)
						{
							var ageN = "";
							var genderN = "";
							var locationN = "";
							var additionalInfoN = "";

							//if the user has entered values into the login boxes then update them, if not get them from the db from last time
							
							if(ageN == "") { ageN = rows[0].age; }
							if(genderN == "") { genderN = rows[0].gender; }
							if(locationN == "") { locationN = rows[0].location; }
							if(additionalInfoN == "") { additionalInfoN = rows[0].additionalInfo; }
						
							con.user = new User(rows[0].nickname, rows[0].accountType, ageN, genderN, locationN, additionalInfoN, rows[0].email, rows[0].profileImage, false);
							con.user.ip = con.ip;
							
							//update the database if values have changed
							
							if(rows[0].age != ageN || rows[0].gender != genderN || rows[0].location != locationN || rows[0].additionalInfo != additionalInfoN)
							{
								executeSimpleQuery("update users set age=" + ageN + ", gender='" + genderN + "', location='" + locationN + "', additionalInfo='" + additionalInfoN + "' where nickname='" + nickname + "'");
							}
							
							//Enable image uploads now...
							
							var uploader = new siofu();
							uploader.dir = process.cwd() + "/public/profIms";
							
							uploader.maxFileSize = maxImageSize * 1000;
							
							uploader.on("error", function(event){
								console.log("Error from uploader", event);
							});
							
							uploader.on("start", function(event)
							{
								var extension = event.file.name.split('.').pop();
								if(extension == 'jpg' || extension == 'jpeg' || extension == 'png' || extension == 'gif')
								{
									//rename to user's nickname + whatever extension the image is
									event.file.name = con.user.nickname + '.' + extension;
								}
							});
							
							uploader.on("saved", function(event)
							{
								if((event.file.name.endsWith(".jpg") || event.file.name.endsWith(".png") || event.file.name.endsWith(".jpeg") || event.file.name.endsWith(".gif")) == false)
								{
									console.log(con.user.nickname + " tried to upload " + event.file.name + " which is not .jpg, .jpeg, .gif or .png...");
									console.log("deleting...");

									fs.unlink(process.cwd() + "/public/profIms/" + event.file.name, function (err)
									{
									  if (err) throw err;
									  console.log("successfully deleted " + process.cwd() + "/public/profIms/" + event.file.name);
									});
								}
								else
								{
									con.user.profileImage = event.file.name;
									
									findChannelByName(con.user.currentChannel).sendEvent('user updated', JSON.stringify(con.user));
									
									executeSimpleQuery("update users set profileImage='" + event.file.name + "' where nickname='" + con.user.nickname + "'");
								}
							});
							
							uploader.listen(con.con);
							con.con.emit('event', {'event': 'addedchatter', nickname: nickname, ownlogin: true});
                            // io.sockets.emit('event', {
                            //     'event': 'chattercount',
                            //     'chattercount': this.getChatterCount()
                            // });
							// con.con.emit('login result', JSON.stringify(con.user));
							
							// con.user.sendChannelList();
							//swapped these
							//findChannelByName("Kletshoek").addToChannel(con.user);
						}
						else
						{
							if(banRows[0].unbanTimestamp > Date.now())
							{
                                con.con.emit('event', {'event': 'error', type:110});
								// con.con.emit('login result', 'banned|' + 'Je bent verbannen door ' + banRows[0].bannedBy + ' tot ' + Date(banRows[0].unbanTimestamp).toString());
								con.con.disconnect();
							}
							else
							{
                                executeSimpleQuery("delete from serverbans where nickname='" + nickname + "'");
                                con.con.emit('event', {'event': 'error', type:102 });
								// con.con.emit('login result', 'banned|' + 'Je hebt weer toegang tot de chatserver, log opnieuw in.');
							}
						}
					});
				
					
				}
				else
				{
                    con.con.emit('event', {'event': 'error', type:110 });
					// con.con.emit('login result', 'fail');
				}
            }
        });
  });
}

function handle_database_channels_load()
{
	pool.getConnection(function(err,connection){
	
        if (err) {
          console.log("database error: " + err);
        }
       
        connection.query("select * from channels;",function(err,rows){
			console.log("started channel loading from database");
            connection.release();
            if(!err) {
				for (var i = 0; i < rows.length; i++)
				{
					var thisChannelFromDB = new Channel(rows[i].name, rows[i].owner, rows[i].topic, rows[i].type, "", rows[i].isStatic);
					thisChannelFromDB.loadPermissionsFromDatabase();
				}
            }
        });
	});
}

function executeSimpleQuery(queryString)
{
	pool.getConnection(function(err,connection){
	
		if (err) {
		  connection.release();
		  console.log("database error: " + err);
		}
	
		connection.query(queryString ,function(err,rows){
			connection.release();
		});
	});
}

function simpleQueryCallBack(queryString, callBackFunc)
{
	pool.getConnection(function(err,connection){
	
		if (err) {
		  connection.release();
		  console.log("database error: " + err);
		}
	
		connection.query(queryString ,function(err,rows){
			connection.release();
			callBackFunc(rows);
		});
	});
}

function handle_database_registration(con, msg)
{
	var nickname = validator.escape(msg.nickname);
    var passwordHash = validator.escape(sha1hash(msg.password));
    console.log(passwordHash);
	var email = validator.escape(msg.email);

	for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
	{
		if(nickname.includes(filterList[filterIndex]))
		{
            con.con.emit('event', {'event': 'registererror', name: 'SERVER: ', message: 'forbidden term', color: 'red' });
			// con.con.emit(' result', 'forbidden term');
			return;
		}
	}
	
	if(validator.isLength(nickname, 3, 20) == false || nickname.indexOf(" ") > -1)
	{
        con.con.emit('event', {'event': 'registererror', name: 'SERVER: ', message: 'nickname wrong', color: 'red' });
		// con.con.emit('register result', 'nickname wrong');
		return;
	}
	
	// if(validator.isLength(passwordHash, 32, 32) == false)
	// {
    //     con.con.emit('event', {'event': 'registererror', name: 'SERVER: ', message: 'password wrong', color: 'red' });
	// 	// con.con.emit('register result', 'password wrong');
	// 	return;
	// }
	
	if (validator.isEmail(email) == false)
	{
        con.con.emit('event', {'event': 'registererror', name: 'SERVER: ', message: 'email wrong', color: 'red' });
		// con.con.emit('register result', 'email wrong');
		return;
	}
	
	
   pool.getConnection(function(err,connection)
   {
		if (err) {
		  connection.release();
		  console.log("database error: " + err);
		}
	   
		connection.query("select * from users where nickname='" + nickname + "'",function(err,rows){
			connection.release();
			if(!err) {
			
				if(rows.length > 0)
				{					
                    con.con.emit('event', {'event': 'registererror', name: 'SERVER: ', message: 'nickname taken', color: 'red' });
					// con.con.emit('register result', 'nickname taken');
					
				}
				else
				{
					//all good, proceed
					
					pool.getConnection(function(err2,connection2)
					{
							if (err2) {
							  connection2.release();
							  console.log("database error: " + err2);
							}
						   
							connection2.query("insert into users values('" + nickname + "', 1, '" + passwordHash + "', 0, '', '', '', '" + email + "', 'none', 'server');",function(err,rows){
								connection2.release();
								if(!err2) {
									con.con.emit('event', {'event': 'registered'});
									// con.con.emit('register result', 'ok');
								}
							});

							connection2.on('error', function(err2) {      
								  console.log("database error: " + err2);
								  con.user = null;
							});
					  });
				}
			}
		});
  });
}

//Set up page serving, i.e. handle / with index, everything with /static in front of it, grab from /public

app.use('/static', express.static('public'));

app.get('/', function(req, res){
  res.sendFile(__dirname + '/index.html');	
});

//Add starting channels
handle_database_channels_load();

//Listen for connections
http.listen(42526, function(){
  console.log('listening on *:' + listenPort);
});

//Event Handling:

io.on('connection', function(socket)
{
	//New connection, push a new Connection instance onto connections array, set User to null initially as they are not yet logged in
	console.log('new connection from ' + socket.request.connection._peername.address);
	connections.push(new Connection(null, socket, socket.request.connection._peername.address));
	
	//Connection lost, remove the Connection instance we made when it was established
	socket.on('disconnect', function()
	{
		var thisCon = findConnectionBySocket(socket);
		// for(var chanindex=0; chanindex<thisCon.Channellist.length; chanindex++)
		// {
		// 	findChannelByName(thisCon.user.Channellist[0].Channel).removeFromChannel(thisCon.user);
		// }
		// console.log('a connection was finished from ' + socket.request.connection._peername.address);
		removeConnection(findConnectionBySocket(socket));
	});
	
	socket.on('error', function(msg)
	{
		console.log('Socket Error : ' + msg);
		console.log(msg.stack);
	});
	
	//Connection is attempting to login...
	//msg should be in form of nickname|md5hash of password

	socket.on('send channel message', function(msg)
	{
		var sender = findConnectionBySocket(socket);
		
		//if(sender.user.xcdrvesl == true)
		//{
		//	sender.con.emit('server message', 'You can not send a message when you are hidden.');
		//}
		
		if(sender.user.bhdedl == false)
		{
		
			var receivedMessage = JSON.parse(msg);
			
			if(validator.isHexColor(receivedMessage.colour) == false)
			{
				receivedMessage.colour = "#000000";
			}
			
			
			// add handle youtube here
			processMessageContent(receivedMessage.content, function(content, isRawMessage) {
				var newMessage = new Message(sender.user.nickname, receivedMessage.colour, content, isRawMessage);
				
				for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
				{
					if(newMessage.content.includes(filterList[filterIndex]))
					{
						sender.con.emit('server message', 'The message you entered contains a forbidden phrase, please try again.');
						return;
					}
				}
			
				findChannelByName(sender.user.currentChannel).sendMessage(newMessage);
			});
		}
		else
		{
			sender.con.emit('server message', 'You do not have permission to talk on channel: ' + sender.user.currentChannel);
		}
	});
	
	socket.on('private message', function(msg)
	{	
		var msgParts = msg.split('|');
	
		var sender = findConnectionBySocket(socket);
		
		var receivedMessage = JSON.parse(msgParts[1]);
		
		if(validator.isHexColor(receivedMessage.colour) == false)
		{
			receivedMessage.colour = "#000000";
		}
		
		var newMessage = new Message(sender.user.nickname, receivedMessage.colour, validator.escape(receivedMessage.content));
		
		for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
		{
			if(newMessage.content.includes(filterList[filterIndex]))
			{
				sender.con.emit('server message', 'The message you entered contains a forbidden phrase, please try again.');
				return;
			}
		}
		
		var receiver = findUserFromStringName(msgParts[0]);
		
		if(receiver != null)
		{
			findConnectionFromUser(receiver).con.emit('private message', JSON.stringify(newMessage));
		}
	});
	
	socket.on('change channel', function(msg)
	{
		msg = validator.escape(msg);
		
		var thisUser = findConnectionBySocket(socket).user;
		
		if(thisUser != null)
		{
			thisUser.bhdedl = false;
			
			socket.emit('changed channel', msg);
			
			if(thisUser.currentChannel != "")
			{
				findChannelByName(thisUser.currentChannel).removeFromChannel(thisUser);
			}
			
			findChannelByName(msg).addToChannel(thisUser);
		}
	});
	
	socket.on('register request', function(msg)
	{
		msg = validator.escape(msg);
	
		var msgParts = msg.split("|");
		
		console.log('register request string: ' + msg)
		
		//(con, nickname, passwordHash, age, gender, location, additionalInfo, email) 
		
		handle_database_registration(findConnectionBySocket(socket), msgParts[0], msgParts[1], msgParts[2]);
	});
	
	socket.on('create channel', function(msg)
	{
		msg = validator.escape(msg);
		
		var msgParts = msg.split("|");
		var thisCon = findConnectionBySocket(socket);
		
		if(msgParts[0].indexOf(" ", 0) != -1)
		{
			thisCon.con.emit('server message', 'Kanaal naam mag geen spatie bevatten.');
			return;
		}
		
		if(msgParts[0].length < 3)
		{
			thisCon.con.emit('server message', 'Channel name must be 3 characters or more.');
			return;
		}
		
		if(findChannelByName(msgParts[0]) == null)
		{
			var cType = 0;
			
			if(msgParts[2] == "Admin")
			{
				cType = 1;
			}
			
			if(thisCon.user != null)
			{
				//add to database
				
				executeSimpleQuery("insert into channels values('" + msgParts[0] + "', '" + thisCon.user.nickname + "', '" + msgParts[1] + "', " + cType + ");");
				
				channels.push(new Channel(msgParts[0], thisCon.user.nickname, msgParts[1], cType, "", 0));
				
				executeSimpleQuery("insert into chatlogs values('" + msgParts[0] + "', '')");

				//Update all users as to the new channelArr
				for	(index = 0; index < connections.length; index++)
				{
					if(connections[index] != null)
					{
						if(connections[index].user != null)
						{
							connections[index].user.sendChannelList();
						}
					}
				}
				
				thisCon.user.bhdedl = false;
		
				socket.emit('changed channel', msgParts[0]);
				
				if(thisCon.user.currentChannel != "")
				{
					findChannelByName(thisCon.user.currentChannel).removeFromChannel(thisCon.user);
				}
				
				findChannelByName(msgParts[0]).addToChannel(thisCon.user);
			}
		}
		else
		{
			thisCon.con.emit('server message', 'Dit kanaal bestaat al.');
		}
	});
	
	socket.on('search', function(msg)
	{
		console.log('search: ' + msg);
	
		var thisCon = findConnectionBySocket(socket);
	
		var msgParts = msg.split("|");
	
		var searchList = [];
		var searchOn = msgParts[0];
		var gender = msgParts[1];
		var name = msgParts[2];
		
		for(var conIndex=0; conIndex<connections.length; conIndex++)
		{
			if(connections[conIndex] != null)
			{
				if(connections[conIndex].user != null)
				{
					var searchOnSatisfied = false;
					var genderSatifised = false;
					var nameSatisfied = false;
					
					if(searchOn == "Channel")
					{
						if(connections[conIndex].user.currentChannel == thisCon.user.currentChannel)
						{
							searchOnSatisfied = true;
						}
					}
					else
					{
						searchOnSatisfied = true;
					}
					
					if(gender != "both")
					{
						if(connections[conIndex].user.gender == gender)
						{
							genderSatifised = true;
						}
					}
					else
					{
						genderSatifised = true;
					}
					
					if(name != "")
					{
						if(connections[conIndex].user.nickname.includes(name))
						{
							nameSatisfied = true;
						}
					}
					else
					{
						nameSatisfied = true;
					}
					
					if(searchOnSatisfied == true && genderSatifised == true && nameSatisfied == true)
					{
						searchList.push(connections[conIndex].user);
					}
				}
			}
		}
		
		thisCon.con.emit('search result', JSON.stringify(searchList));
		
    });
    // socket.on('command', handleCommands);
	// function handleCommands (data) {
    //     var command = data.command || 'handleError';
    //     if (typeof chatServer[command] === 'function') {
    //         chatServer[command](data, socket);
    //     }
    // }
	socket.on('command', function(msg)
	{
		//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 3=creator

        var thisCon = findConnectionBySocket(socket);
        if(msg.command == 'register')
        {
            console.log('register request string: ' + msg);
            console.log(msg);
            handle_database_registration(findConnectionBySocket(socket), msg);
        }
        else if(msg.command == 'signup')
        {
            console.log('signup');
            var thisCon = findConnectionBySocket(socket);
        
            simpleQueryCallBack("select * from serverbans where ip='" + thisCon.ip + "'", function(brows)
            {
                if(brows.length > 0)
                {
                    if(brows[0].unbanTimestamp > Date.now())
                    {
                        thisCon.con.emit('event', {'event': 'error', type:102,name: 'SERVER: ', message: 'banned|' + 'Je bent verbannen door ' + brows[0].bannedBy + ' tot ' + Date(brows[0].unbanTimestamp).toString(), color: 'red' });
                        // thisCon.con.emit('login result', 'banned|' + 'Je bent verbannen door ' + brows[0].bannedBy + ' tot ' + Date(brows[0].unbanTimestamp).toString());
                        thisCon.con.disconnect();
                    }
                    else
                    {
                        executeSimpleQuery("delete from serverbans where ip='" + thisCon.ip + "'");
                        thisCon.con.emit('event', {'event': 'error',type:102, name: 'SERVER: ', message: 'banned|' + 'Je hebt weer toegang tot de chatserver, log opnieuw in.', color: 'red' });
                        // thisCon.con.emit('login result', 'banned|' + 'Je hebt weer toegang tot de chatserver, log opnieuw in.');
                    }
                }
                else
                {
                    // var msgParts = msg.split("|");
                    //msgParts[0] = msgParts[0].toLowerCase();
                    var nickname = msg.nickname;
                    if(nickname.length < 3)
                    {
                        socket.emit('event', {'event': 'error',type:102, name: 'SERVER: ', message: 'fail|too short', color: 'red' });
                        // socket.emit('login result', "fail|too short");
                        return;
                    }
                    
                    if(isUserLoggedIn(nickname) == true)
                    {
                        socket.emit('event', {'event': 'error',type:102, name: 'SERVER: ', message: 'fail|logged in', color: 'red' });
                        // socket.emit('login result', "fail|logged in");
                        return;
                    }
                    // else if(msgParts[1] == "guest")
                    // {
                    // 	//i.e. user logging in as a guest
                        
                    // 	//ensure the guest username isn't already taken by an actual user
                            
                    // 	simpleQueryCallBack("select * from users where nickname='" + msgParts[0] + "'", function(rows)
                    // 	{
                    // 		if(rows.length == 0)
                    // 		{
                    // 			msgParts[0] = "~" + msgParts[0];
                            
                    // 			if(isUserLoggedIn(msgParts[0]) == true)
                    // 			{
                    // 				//guest with that name already logged in
                    // 				socket.emit('login result', "fail|guest taken");
                    // 			}
                    // 			else
                    // 			{
                    // 				thisCon.user = new User(msgParts[0], 0, msgParts[2], msgParts[3], msgParts[4], msgParts[5], '', 'none', false);
                    // 				thisCon.user.ip = thisCon.ip;
                    // 				thisCon.con.emit('login result', JSON.stringify(thisCon.user));
                                    
                    // 				thisCon.user.sendChannelList();
                    // 				//swapped these
                    // 				//findChannelByName("Kletshoek").addToChannel(thisCon.user);
                    // 			}
                    // 		}
                    // 		else
                    // 		{
                    // 			//actual user with that name exists
                    // 			socket.emit('login result', "fail|actual user");
                    // 		}	
                    // 	});
                    // }
                    // else
                    {
                        handle_database_login(thisCon, msg);
                    }
                }
            });
        }
		if(thisCon.user != null)
		{
			var userChannel = findChannelByName(msg.channel);
			
			if(msg.command == "part")
			{
                console.log("arrive");
                console.log(thisCon.user);
				thisCon.con.emit('event', {'event':'parted',channel:msg.channel,name:thisCon.user.nickname});
			
				userChannel.removeFromChannel(thisCon.user);
				// findChannelByName("Hulp").addToChannel(thisCon.user);
			}
			else if(msg.command == "youtube_add_video")
			{
				console.log(msg);
				var sender = findConnectionBySocket(socket);
                if(!!msg.channel)
                {
                    //if(sender.user.xcdrvesl == true)
                    //{
                    //	sender.con.emit('server message', 'You can not send a message when you are hidden.');
                    //}
                    
                    if(sender.user.bhdedl == false)
                    {
                        findChannelByName(msg.channel).sendEvent('youtube_video_added',{channel:msg.channel,queue:msg.url});
                    }
                    else
                    {
                        sender.con.emit('event', {'event': 'servermessage', message: 'You do not have permission to talk on channel: ' + sender.user.currentChannel, color: 'red' });
                        // sender.con.emit('server message', 'You do not have permission to talk on channel: ' + sender.user.currentChannel);
                    }
                }
			}
			else if(msg.command == "youtube_stop_video")
			{
				console.log(msg);
				var sender = findConnectionBySocket(socket);
                if(!!msg.channel)
                {
                    //if(sender.user.xcdrvesl == true)
                    //{
                    //	sender.con.emit('server message', 'You can not send a message when you are hidden.');
                    //}
                    
                    if(sender.user.bhdedl == false)
                    {
                        findChannelByName(msg.channel).sendEvent('youtube_stop_video',{channel:msg.channel,queue:msg.url});
                    }
                    else
                    {
                        sender.con.emit('event', {'event': 'servermessage', message: 'You do not have permission to talk on channel: ' + sender.user.currentChannel, color: 'red' });
                        // sender.con.emit('server message', 'You do not have permission to talk on channel: ' + sender.user.currentChannel);
                    }
                }
			}
			else if(msg.command == "youtube_playlist_start")
			{
				
			}
			else if(msg.command == "youtube_playlist_stop")
			{
				
			}
			else if(msg.command == "youtube_get_video")
			{
				
			}
			else if(msg.command == "youtube_throw_tomato")
			{
				
			}
			else if(msg.command == "youtube_get_playlist")
			{
				
			}
			else if(msg.command == "youtube_remove_video")
			{
				
			}
            else if(msg.command == "join")
			{
				if(msg.channel.length>0)
				{
					var chan = findChannelByName(msg.channel);
					
					if(chan == null)
					{
						if(msg.channel.length < 3)
						{
							thisCon.con.emit('servermessage', 'The channel name must be 3 or more characters in length.');
							return;
						}
						
						if(msg.channel.indexOf(" ", 0) != -1)
						{
							thisCon.con.emit('servermessage', 'The channel name must not contain spaces.');
						}
					
						executeSimpleQuery("insert into channels values('" + msg.channel + "', '" + thisCon.user.nickname + "', '', " + 5 + ");");
					
                        channels.push(new Channel(msg.channel, thisCon.user.nickname, "", 5, "", 0));
                        // if(thisCon.user.accountType<3)
    					// 	thisCon.user.accountType = 3;
						executeSimpleQuery("insert into chatlogs values('" + msg.channel + "', '')");
						
						//Update all users as to the new channelArr
						for	(index = 0; index < connections.length; index++)
						{
							if(connections[index] != null)
							{
								if(connections[index].user != null)
								{
									connections[index].user.sendChannelList();
								}
							}
						}
						
						chan = findChannelByName(msg.channel);
                    }
                    // console.log(thisCon.user.currentChannel);
                    if(thisCon.user.Channellist.length>0)
                    {
						if(thisCon.user.Channellist.length == 2)
						{
							thisCon.con.emit('event', {'event':'parted',channel:thisCon.user.Channellist[0].Channel,name:thisCon.user.nickname});
							findChannelByName(thisCon.user.Channellist[0].Channel).removeFromChannel(thisCon.user);
						}
                    }
                    // thisCon.con.emit('event', {event: 'joined', name: thisCon.user.nickname,profile:convertUserLevelIntToString(thisCon.user.accountType), channel: chan.name, hidden: false});
                    findChannelByName(chan.name).addToChannel(thisCon.user);
				}
				else
				{
					thisCon.con.emit('event', {event:"servermessage",color:"red",message:'Format is: /join channelname'});
				}
			}
			else if(msg.command == "getchannelinfo")
			{
				var ch = null;
				var chanindex,conindex;
				//Next, check if the user is in the same channel as the user attempting the command
				
				for(var j =0 ; j<thisCon.user.Channellist.length;j++)
				{
					if(thisCon.user.Channellist[j].Channel === msg.channel)
					{
						ch = findChannelByName(msg.channel);
						conindex = j;
						break;
					}
				}
				console.log(ch);
				console.log(conindex);
				if(ch==null||conindex==undefined)
				{
					thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'That user is not in the channel currently', color: 'red' });
					// thisCon.con.emit('server message', 'That user is not in the channel currently');
					return;
				}
				// thisCon.con.emit('event',{event:'channelinfo',name:thisCon.user.nickname,channel:thisCon.user.Channellist[conindex].Channel,info:{type:thisCon.user.Channellist[conindex].Channel.toLowerCase()}});
			}
            else if(msg.command == "setchannelinfo")
            {
                if(thisCon.user != null)
				{
					var ch = null;
					var chanindex,conindex;
					//Next, check if the user is in the same channel as the user attempting the command
					
					for(var j =0 ; j<thisCon.user.Channellist.length;j++)
					{
						if(thisCon.user.Channellist[j].Channel === msg.channel)
						{
							ch = findChannelByName(msg.channel);
							conindex = j;
							break;
						}
					}
					console.log(ch);
					console.log(conindex);
					if(ch==null||conindex==undefined)
					{
						thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'That user is not in the channel currently', color: 'red' });
						// thisCon.con.emit('server message', 'That user is not in the channel currently');
						return;
					}
					if(thisCon.user.Channellist[conindex].ChannelUserLevel == 5 || thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 2)
					{
                        console.log("arrivesetchan");
                        console.log(thisCon.user.Channellist[conindex].ChannelUserLevel);
						var thisCh = findChannelByName(thisCon.user.Channellist[conindex].Channel);
						
						var parsedTopic = "";
						var topicParts = msg.info.topic.split(" ");
						
						var firstCol = true;
						
						for(var partsIndex=0; partsIndex<topicParts.length; partsIndex++)
						{
							if(/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(topicParts[partsIndex]))
							{
								if(firstCol == true)
								{
									firstCol = false;
								}
								else
								{
									parsedTopic += "</span>";
								}
								
								parsedTopic += "<span style=\"color: " + topicParts[partsIndex] + "\">";
							}
							else
							{
								parsedTopic += " " + topicParts[partsIndex];
							}
						}
						
						if(firstCol == false)
						{
							parsedTopic += "</span>";
						}
						
                        thisCh.topic = parsedTopic;
						thisCh.sendEvent('channelinfo',{name:thisCon.user.nickname,channel:thisCon.user.Channellist[conindex].Channel,info:{topic:thisCh.topic}});
                        // thisCh.sendEvent('channel topic update', thisCh.topic);
                        // thisCh.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft de topic verandert'});
                        // thisCh.sendEvent('servermessage', {name: 'Nieuw Topic: ', message: thisCh.topic});
						// thisCh.sendEvent('server message', thisCon.user.nickname + ' heeft de topic verandert');
						// thisCh.sendEvent('server message', 'Nieuw Topic: ' + thisCh.topic);
					}
					else
					{
						thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					}
				}
            }
            else if(msg.command == "getuserinfo")
            {
                console.log("userinfo");
                var userinfo = findUserFromStringName(msg.target);
                userinfo['event'] = 'userinfo';
                console.log(userinfo);
                thisCon.con.emit('event', {event: 'userinfo', name:userinfo.nickname,
                info:{age:userinfo.age.toString(),gender:userinfo.gender,domicile:userinfo.location,website:userinfo.email,extra:userinfo.additionalInfo}
                ,connecttime:Date.now()-userinfo.loggedIn,idletime:Date.now()-userinfo.lastActive,ip:userinfo.ip,browser:"",os:"",
                device:"",alias:"",country:"",hostname:"",referer:"",ident:""
                });
            }
            else if(msg.command == "channelmessage")
            {
                
                var sender = findConnectionBySocket(socket);
                if(!!msg.channel)
                {
                    //if(sender.user.xcdrvesl == true)
                    //{
                    //	sender.con.emit('server message', 'You can not send a message when you are hidden.');
                    //}
                    
                    if(sender.user.bhdedl == false)
                    {
                    
                        var receivedMessage = msg.message;
                        
                        if(validator.isHexColor(msg.color) == false)
                        {
                            msg.color = "#000000";
                        }
                        
                        
                        // add handle youtube here
                        processMessageContent(receivedMessage, function(content, isRawMessage) {
                            var newMessage = new Message(sender.user.nickname, msg.color, content, isRawMessage);
                            
                            for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
                            {
                                if(newMessage.content.includes(filterList[filterIndex]))
                                {
                                    sender.con.emit('event', {'event': 'servermessage', message: 'The message you entered contains a forbidden phrase, please try again.', color: 'red' });
                                    // sender.con.emit('server message', 'The message you entered contains a forbidden phrase, please try again.');
                                    return;
                                }
                            }
                            console.log(msg.channel);
                            console.log(findChannelByName(msg.channel));
                            findChannelByName(msg.channel).sendMessage(newMessage);
                        });
                    }
                    else
                    {
                        sender.con.emit('event', {'event': 'servermessage', message: 'You do not have permission to talk on channel: ' + sender.user.currentChannel, color: 'red' });
                        // sender.con.emit('server message', 'You do not have permission to talk on channel: ' + sender.user.currentChannel);
                    }
                }
			}
			else if(msg.command == "privatemessage")
			{
				var sender = findConnectionBySocket(socket);
				var receivedMessage = msg.message;
                        
				if(validator.isHexColor(msg.color) == false)
				{
					msg.color = "#000000";
				}
				
				
				// add handle youtube here
				processMessageContent(receivedMessage, function(content, isRawMessage) {
					var newMessage = new Message(sender.user.nickname, msg.color, content, isRawMessage);
					
					for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
					{
						if(newMessage.content.includes(filterList[filterIndex]))
						{
							sender.con.emit('event', {'event': 'servermessage', message: 'The message you entered contains a forbidden phrase, please try again.', color: 'red' });
							// sender.con.emit('server message', 'The message you entered contains a forbidden phrase, please try again.');
							return;
						}
					}
					var receiver = findUserFromStringName(msg.target);
				
					if(receiver != null)
					{
						findConnectionFromUser(receiver).con.emit('event',{event:'privatemessage', name:sender.user.nickname,target:msg.target,channel:msg.channel,message:newMessage.content,color:newMessage.color});
					}
				});
			}
            else if(msg.command == "channellist")
			{
                var channellist =[];
                for (var schannel in channels) {
                    var rch  = channels[schannel];
                    rch['usercount'] = channels[schannel].currentUsers;
                    channellist.push(rch);
                }
				thisCon.con.emit('event', {event: 'channellist', channels: channellist, hjoin: false});
            }
            else if(msg.command == "userlist")
            {
                thisCon.user.sendInitialChannelUsers();
            }
			else if(msg.command == "servermessage")
			{
                console.log(thisCon.user);
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 5)
				{
					//must be cyber or admin to use walls
					
					var messageParts = msg.message;
					var parsedMessage = "";
					
					var firstCol = true;
					
					for(var partsIndex=1; partsIndex<messageParts.length; partsIndex++)
					{
					// 	if(/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(messageParts[partsIndex]))
					// 	{
					// 		if(firstCol == true)
					// 		{
					// 			firstCol = false;
					// 		}
					// 		else
					// 		{
					// 			parsedMessage += "</span>";
					// 		}
							
					// 		parsedMessage += "<span style=\"color: " + messageParts[partsIndex] + "\">";
					// 	}
					// 	else
					// 	{
							parsedMessage += messageParts[partsIndex];
					//	}
					}
					
					// if(firstCol == false)
					// {
					// 	parsedMessage += "</span>";
					// }
					
					sendServerMessageToAllLoggedInUsers({name:"server",message:parsedMessage,color:'red'});
				}
				else
				{
                    thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'Deze actie is niet toegestaan', color: 'red' });
					// thisCon.con.emit('server message', 'Deze actie is niet toegestaan');
				}
			}
			// else if(msg.command == "/whois")
			// {
			// 	var found = findUserFromStringName(msg.replace("/whois ", ""));
				
			// 	if(found != null)
			// 	{
			// 		thisCon.con.emit('server message', found.nickname + ' is in kanaal ' + found.currentChannel);
			// 	}
			// 	else
			// 	{
			// 		thisCon.con.emit('server message', msg.replace("/whois ", "") + ' gebruiker niet ingelogd, of bestaat niet.');
			// 	}
			// }
			else if(msg.command == "op")
			{
				var userToUpgrade = findUserFromStringName(msg.target);
				
				//First, check if the user actually exists
				if(userToUpgrade == null)
				{
                    thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'That user is not logged in or does not exist', color: 'red' });
					// thisCon.con.emit('server message', 'That user is not logged in or does not exist');
					return;
				}
				
				var carryOut = false;
				var stopError = false;
				var positionToSet = convertUserLevelStringToInt(msg.profile);
				var ch = null;
				var chanindex,conindex;
				//Next, check if the user is in the same channel as the user attempting the command
				
				for(var i =0 ; i<userToUpgrade.Channellist.length;i++)
				{
					console.log(userToUpgrade.Channellist[i].Channel);
					if(userToUpgrade.Channellist[i].Channel == msg.channel)
					{
						console.log("arrive");
						ch = findChannelByName(msg.channel);
						chanindex = i;
						break;
					}
				}
				for(var j =0 ; j<thisCon.user.Channellist.length;j++)
				{
					if(thisCon.user.Channellist[j].Channel === msg.channel)
					{
						conindex = j;
						break;
					}
				}
				if(ch==null||conindex==undefined)
				{
                    thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'That user is not in the channel currently', color: 'red' });
					// thisCon.con.emit('server message', 'That user is not in the channel currently');
					return;
				}
				//Next, check if the account type was recognised
				if(positionToSet == null)
				{
                    thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'Account type must be normal, oper, super, cyber or admin', color: 'red' });
					// thisCon.con.emit('server message', 'Account type must be normal, oper, super, cyber or admin');
					return;
				}
			
				if(thisCon.user.accountType == 5 || (thisCon.user.accountType == 4 && userToUpgrade.accountType != 5 && positionToSet != 5))
				{
					//Admin/Cyber can op anyone to anything (as long as not cyber oping admin)
					
					carryOut = true;
				}
				else if(userToUpgrade.nickname == thisCon.user.nickname)
				{
					//i.e. this user is trying to perform an op command on themself...
					
					if(ch.creator == thisCon.user.nickname&& positionToSet != 4 && positionToSet != 5)
					{
						//user is the channel creator, let them op to anything other than cyber or admin
						
						carryOut = true;
					}
					else if(positionToSet == 1 && userToUpgrade.Channellist[chanindex].ChannelUserLevel >1)
					{
						//user is not normal already, but making themself normal now...
						
						carryOut = true;
					}
					else
					{
						//check if the user has autoop permissions
						stopError = true;
						
						simpleQueryCallBack("select * from channelrights where nickname='" + thisCon.user.nickname + "' and channelName='" + ch.name + "';", function(rows)
						{
							if(rows.length == 1)
							{
								//callback, so will be fired after the below so gotta duplicate
								
								if(rows[0].level == 3 && (positionToSet != 5 && positionToSet != 4))
								{
									carryOut = true;
								}
								else if(rows[0].level >= positionToSet)
								{
									carryOut = true;
								}
								
								if(carryOut == true)
								{
									userToUpgrade.Channellist[chanindex].ChannelUserLevel = positionToSet;
									userToUpgrade.userWhoGave = thisCon.user.nickname;
									ch.sendEvent('op',{event:"op",name:thisCon.user.nickname,target:msg.target,profile:msg.profile,channel:msg.channel});
									
									// ch.sendEvent('servermessage', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + " " + commandParts[2] + " gemaakt op kanaal " + ch.name);
								}
								else
								{
                                    thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.', color: 'red' });
									// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
									return;
								}
							}
							else
							{
                                thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.', color: 'red' });
								// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
								return;
							}
						});
					}
				}
				else
				{
					//i.e. this user is trying to perform an op command on a different user
					if(thisCon.user.Channellist[conindex].ChannelUserLevel == userToUpgrade.Channellist[chanindex].ChannelUserLevel || compareUserLevels(thisCon.user.Channellist[conindex].ChannelUserLevel, userToUpgrade.Channellist[chanindex].ChannelUserLevel))
					{
						carryOut = true;
					}
				}
				
				//now we know if the command should be carried and what level to set to:
				
				if(carryOut == true)
				{
					userToUpgrade.Channellist[chanindex].ChannelUserLevel = positionToSet;
					userToUpgrade.userWhoGave = thisCon.user.nickname;
					ch.sendEvent('op',{event:"op",name:thisCon.user.nickname,target:msg.target,profile:msg.profile,channel:msg.channel});
					// ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
					
					// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + " " + commandParts[2] + " gemaakt op kanaal " + ch.name);
				}
				else if(stopError == false)
				{
                    thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					return;
				}
			}
			else if(msg.command == "deop")
			{
				if(thisCon.user != null)
				{
					if(!msg.target)
					{
						//User deoping themself i.e. /deop
						var ch = null;
						var chanindex,conindex;
						//Next, check if the user is in the same channel as the user attempting the command
						for(var j =0 ; j<thisCon.user.Channellist.length;j++)
						{
							if(thisCon.user.Channellist[j].Channel == msg.channel)
							{
								conindex = j;
								break;
							}
						}
						if(conindex==undefined)
						{
							thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'That user is not in the channel currently', color: 'red' });
							// thisCon.con.emit('server message', 'That user is not in the channel currently');
							return;
						}
						var ch = findChannelByName(msg.channel);
						
						//only available to super, oper
						if(thisCon.user.Channellist[conindex].ChannelUserLevel == 2  || thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 4)
						{
							/*if(thisCon.user.currentChannelUserLevel == 1)
							{
								for(var pIndex=0; pIndex<ch.permOperators.length; pIndex++)
								{
									if(ch.permOperators[pIndex] != null)
									{
										if(ch.permOperators[pIndex].nickname == thisCon.user.nickname)
										{
											ch.permOperators[pIndex] = null;
										}
									}
								}
							}
							else if(thisCon.user.currentChannelUserLevel == 2)
							{
								for(var pIndex=0; pIndex<ch.permSuperAdmins.length; pIndex++)
								{
									if(ch.permSuperAdmins[pIndex] != null)
									{
										if(ch.permSuperAdmins[pIndex].nickname == thisCon.user.nickname)
										{
											ch.permSuperAdmins[pIndex] = null;
										}
									}
								}
							}*/ //commented out this because got confused between /deop and /autodeop
						
							thisCon.user.Channellist[conindex].ChannelUserLevel = 1;
                            // ch.sendEvent('deop',{event:"deop",name:thisCon.user.nickname,target:msg.target,profile:msg.profile,channel:msg.channel});                            
                            // ch.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft ' + thisCon.user.nickname + ' normaal gemaakt op kanaal ' + ch.name});
							ch.sendEvent('op', {name: thisCon.user.nickname, target:thisCon.user.nickname,profile:"normal",channel:ch.name});
							// ch.sendEvent('user updated', JSON.stringify(thisCon.user));
							
							// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + thisCon.user.nickname + ' normaal gemaakt op kanaal ' + ch.name);
						}
						else if(thisCon.user.Channellist[conindex].ChannelUserLevel == 5)
						{
							thisCon.user.Channellist[conindex].ChannelUserLevel = 1;
							
							// ch.sendEvent('user updated', JSON.stringify(thisCon.user));
							
                            // ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + thisCon.user.nickname + ' normaal gemaakt op kanaal ' + ch.name);
                            ch.sendEvent('op', {name: thisCon.user.nickname, target:thisCon.user.nickname,profile:"normal",channel:ch.name});
						}
						else
						{
                            thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
							// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
						}
					}
					else
					{
						var userToDowngrade = findUserFromStringName(msg.target);
						//deoping someone else, i.e. /deop user
						var ch = null;
						var chanindex,conindex;
						//Next, check if the user is in the same channel as the user attempting the command
						for(var i =0 ; i<userToDowngrade.Channellist.length;i++)
						{
							if(userToDowngrade.Channellist[i].Channel == msg.channel)
							{
								ch = findChannelByName(msg.channel);
								chanindex = i;
								break;
							}
						}
						for(var j =0 ; j<thisCon.user.Channellist.length;j++)
						{
							if(thisCon.user.Channellist[j].Channel == msg.channel)
							{
								conindex = j;
								break;
							}
						}
						if(ch==null||conindex == undefined)
						{
							thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
							// thisCon.con.emit('server message', 'That user is not in the channel currently');
							return;
						}
						if(thisCon.user.Channellist[conindex].ChannelUserLevel == 5 || thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 2)
						{
							
							if(userToDowngrade != null)
							{
								if(userToDowngrade.Channellist[chanindex].ChannelUserLevel == 2 || userToDowngrade.Channellist[chanindex].ChannelUserLevel == 3)
								{
									if(compareUserLevels(thisCon.user.Channellist[conindex].ChannelUserLevel, userToDowngrade.Channellist[chanindex].ChannelUserLevel) || thisCon.user.Channellist[conindex].ChannelUserLevel == 4)  //rights check
									{
										// if(thisCon.user.currentChannel != userToDowngrade.currentChannel)
										// {
                                        //     thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'the user you specified is not in this channel at present.'});
										// 	// thisCon.con.emit('server message', 'the user you specified is not in this channel at present.');
										// 	return;
										// }
									
										userToDowngrade.Channellist[chanindex].ChannelUserLevel = 1;
										userToDowngrade.userWhoGave = thisCon.user.nickname;
										
										var ch = findChannelByName(msg.channel);
										ch.sendEvent('op', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:"normal",channel:ch.name});
										// ch.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + " normaal gemaakt op kanaal " + ch.name});
										// ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
										
										// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + " normaal gemaakt op kanaal " + ch.name);
									}
									else
									{
                                        thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
										// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
									}
								}
								else
								{
                                    thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'That user is not oper or super, did you mean /sdeop?'});
									// thisCon.con.emit('server message', 'That user is not oper or super, did you mean /sdeop?');
								}
							}
						}
						else
						{
                            thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
							// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
						}
						
						//end here
					}
				}
			}
			else if(msg.command == "sdeop")
			{
				if(thisCon.user.accountType == 5)
				{
					var userToDowngrade = findUserFromStringName(msg.target);
					
					if(userToDowngrade != null)
					{

						if(userToDowngrade.accountType == 3)
						{
							userToDowngrade.accountType = 1;
							var ch = null;
							var chanindex,conindex;
							//Next, check if the user is in the same channel as the user attempting the command
							for(var i =0 ; i<userToDowngrade.Channellist.length;i++)
							{
								var ch = findChannelByName(userToDowngrade.Channellist[i].Channel);
								userToDowngrade.Channellist[i].ChannelUserLevel = 1;
								ch.sendEvent('sdeop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:"normal"});
							}
							// ch.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en tijdelijk blijvende rechten afgenomen.'});
							// ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
							
							// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en tijdelijk blijvende rechten afgenomen.');
						}
					}
				}
				else
				{
                    thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "autosdeop")
			{
				if(thisCon.user.accountType == 5)
				{
					var userToDowngrade = findUserFromStringName(msg.target);
					
					if(userToDowngrade != null)
					{
						if(userToDowngrade.accountType == 3 || userToDowngrade.accountType == 4)
						{
							userToDowngrade.accountType = 1;
							// userToDowngrade.currentChannelUserLevel = 1;
							// userToDowngrade.prevChannelUserLevel = 1;
							
							// var ch = findChannelByName(userToDowngrade.currentChannel);
							
							pool.getConnection(function(err,connection){
	
								if (err) {
								  connection.release();
								  console.log("database error: " + err);
								}
							   
								connection.query("update users set accountType=1 where nickname='" + userToDowngrade.nickname + "';",function(err,rows){
									connection.release();
									console.log("done autosdeop query");
								});
							});
							for(var i =0 ; i<userToDowngrade.Channellist.length;i++)
							{
								userToDowngrade.Channellist[i].ChannelUserLevel = 1;
								var ch = findChannelByName(userToDowngrade.Channellist[i].Channel);
								ch.sendEvent('sdeop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:"normal"});
							}
							// ch.sendEvent('sdeop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:"normal"});

							// if(userToDowngrade.prevChannel != "")
							// {
							// 	var ch1 = findChannelByName(userToDowngrade.prevChannel);							
							// 	ch1.sendEvent('sdeop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:"normal"});
							// }
							// ch.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en blijvende rechten afgenomen.'});
							// ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
							
							// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en blijvende rechten afgenomen.');
						}
					}
				}
				else
				{
                    thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "sop")
			{
				if(thisCon.user.accountType == 5)
				{
					var userToUpgrade = findUserFromStringName(msg.target);
					
					if(userToUpgrade != null)
					{
						if((userToUpgrade.accountType != 5 && msg.profile == "admin") || (userToUpgrade.accountType != 4 && userToUpgrade.accountType != 5 && msg.profile == "cyber") || (userToUpgrade.accountType == 5 && userToUpgrade.nickname == thisCon.user.nickname))
						{	
							userToUpgrade.accountType = convertUserLevelStringToInt(msg.profile);
							// userToUpgrade.currentChannelUserLevel =userToUpgrade.prevChannelUserLevel = convertUserLevelStringToInt(msg.profile);
							
							// var ch = findChannelByName(userToUpgrade.currentChannel);
							
							
							for(var i =0 ; i<userToUpgrade.Channellist.length;i++)
							{
								userToUpgrade.Channellist[i].ChannelUserLevel = convertUserLevelStringToInt(msg.profile);;
								var ch = findChannelByName(userToUpgrade.Channellist[i].Channel);
								ch.sendEvent('sop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:msg.profile});
							}
							// ch.sendEvent('sop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:msg.profile});
							// if(userToUpgrade.prevChannel!="")
							// {
							// 	var ch1 = findChannelByName(userToUpgrade.prevChannel);
							// 	ch1.sendEvent('sop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:msg.profile});
							// }
							// ch.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + msg.profile});
							// ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
							
							// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + msg.profile );
						}
					}
				}
				else
				{
                    thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "autosop")
			{
				if(thisCon.user.accountType == 5)
				{
					var userToUpgrade = findUserFromStringName(msg.target);
					
					if(userToUpgrade != null)
					{
						if((userToUpgrade.accountType != 5 && msg.profile == "admin") || (userToUpgrade.accountType != 4 && userToUpgrade.accountType != 5 && msg.profile == "cyber") || (userToUpgrade.accountType == 5 && userToUpgrade.nickname == thisCon.user.nickname))
						{	
							userToUpgrade.accountType = convertUserLevelStringToInt(msg.profile);
							// userToUpgrade.currentChannelUserLevel =userToUpgrade.prevChannelUserLevel = convertUserLevelStringToInt(msg.profile);
							
							// var ch = findChannelByName(userToUpgrade.currentChannel);
							
							pool.getConnection(function(err,connection){
	
								if (err) {
								  connection.release();
								  console.log("database error: " + err);
								}
							
								connection.query("update users set accountType=" + convertUserLevelStringToInt(msg.profile) + " where nickname='" + userToUpgrade.nickname + "';",function(err,rows){
									connection.release();
									console.log("done autoop query");
								});
							});
							for(var i =0 ; i<userToUpgrade.Channellist.length;i++)
							{
								userToUpgrade.Channellist[i].ChannelUserLevel = convertUserLevelStringToInt(msg.profile);;
								var ch = findChannelByName(userToUpgrade.Channellist[i].Channel);
								ch.sendEvent('sop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:msg.profile});
							}
							// ch.sendEvent('sop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:msg.profile});
							// if(userToUpgrade.prevChannel!="")
							// {
							// 	var ch1 = findChannelByName(userToUpgrade.prevChannel);
							// 	ch1.sendEvent('sop', {name: thisCon.user.nickname, target:userToDowngrade.nickname,profile:msg.profile});
							// }
							// ch.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + msg.profile});
							// ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
							
							// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + msg.profile );
						}
					}
				}
				else
				{
                    thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "autoop")
			{
				if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3) //creator, admin, cyber, super only
				{
					var userToUpgrade = findUserFromStringName(msg.target);
					
					if(userToUpgrade != null)
					{
						var ch = null;
						var chanindex,conindex;
						//Next, check if the user is in the same channel as the user attempting the command
						for(var i =0 ; i<userToUpgrade.Channellist.length;i++)
						{
							if(userToUpgrade.Channellist[i].Channel == msg.channel)
							{
								ch = findChannelByName(msg.channel);
								chanindex = i;
								break;
							}
						}
						for(var j =0 ; j<thisCon.user.Channellist.length;j++)
						{
							if(thisCon.user.Channellist[j].Channel == msg.channel)
							{
								conindex = j;
								break;
							}
						}
						if(ch==null||conindex == undefined)
						{
							thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.'});
							// thisCon.con.emit('server message', 'That user is not in the channel currently');
							return;
						}
						// if(thisCon.user.currentChannel != userToUpgrade.currentChannel && thisCon.user.currentChannel != userToUpgrade.prevChannel)
						// {
						// 	thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'the user you specified is not in this channel at present.'});
						// 	// thisCon.con.emit('server message', 'the user you specified is not in this channel at present.');
						// 	return;
						// }
						// if(thisCon.user.currentChannel == userToUpgrade.currentChannel)
						// {
							if(compareUserLevels(thisCon.user.Channellist[conindex].ChannelUserLevel, userToUpgrade.Channellist[chanindex].ChannelUserLevel) || thisCon.user.Channellist[conindex].ChannelUserLevel == 5) //ranking check
							{						
								if(msg.profile == "oper" || msg.profile == "super")
								{
									userToUpgrade.Channellist[chanindex].ChannelUserLevel = convertUserLevelStringToInt(msg.profile);
									userToUpgrade.userWhoGave = thisCon.user.nickname;
									
									var ch = findChannelByName(userToUpgrade.Channellist[chanindex].Channel);
									
									pool.getConnection(function(err,connection){
		
										if (err) {
										connection.release();
										console.log("database error: " + err);
										}
									
										connection.query("delete from channelrights where channelName='" + thisCon.user.Channellist[conindex].Channel + "' AND nickname='" + userToUpgrade.nickname + "';",function(err,rows){
											connection.release();
											
											executeSimpleQuery("insert into channelrights values('" + thisCon.user.Channellist[conindex].Channel + "', '" + userToUpgrade.nickname + "', '" + thisCon.user.nickname + "', " + convertUserLevelStringToInt(msg.profile) + ");");
											
										});
									});
									
									if(msg.profile == "super")
									{
										ch.permSuperAdmins.push({nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname});
									}
									else if(msg.profile == "oper")
									{
										ch.permOperators.push({nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname});
									}
									ch.sendEvent('autoop', {name: thisCon.user.nickname, target:userToUpgrade.nickname, profile: msg.profile,channel:ch.name});
									// ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
									
									// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + " blijvende " + commandParts[2] + " rechten gegeven op kanaal  " + ch.name);
								}
							}
							else
							{
								thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Permission Denied.'});
								// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Permission Denied.'});
							}
						// }
							
					}
				}
				else
				{
                    thisCon.con.emit('event', {event:'servermessage',name: 'SERVER: ', message: 'Permission Denied.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Permission Denied.'});
				}
			}
			else if(msg.command == "autodeop")
			{
				var conindex;
				for(var j =0 ; j<thisCon.user.Channellist.length;j++)
				{
					if(thisCon.user.Channellist[j].Channel == msg.channel)
					{
						conindex = j;
						break;
					}
				}
				if(conindex == undefined)
				{
					thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
					// thisCon.con.emit('server message', 'That user is not in the channel currently');
					return;
				}
				if(thisCon.user.Channellist[conindex].ChannelUserLevel == 5 || thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || thisCon.user.Channellist[conindex].ChannelUserLevel == 3) //creator, admin, cyber, super only
				{
					//do the query first in case the user isn't logged in etc.
					executeSimpleQuery("delete from channelrights where channelName='" + msg.channel + "' and nickname='" + msg.target + "';");
					
					var userToDowngrade = findUserFromStringName(msg.target);
					
					if(userToDowngrade != null)
					{
						var userToDowngrade = findUserFromStringName(msg.target);
						//deoping someone else, i.e. /deop user
						var ch = null;
						var chanindex;
						//Next, check if the user is in the same channel as the user attempting the command
						for(var i =0 ; i<userToDowngrade.Channellist.length;i++)
						{
							if(userToDowngrade.Channellist[i].Channel == msg.channel)
							{
								ch = findChannelByName(msg.channel);
								chanindex = i;
								break;
							}
						}

						if(ch == null)
						{
							thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
							// thisCon.con.emit('server message', 'That user is not in the channel currently');
							return;
						}
						
						if(compareUserLevels(thisCon.user.Channellist[conindex].ChannelUserLevel, userToDowngrade.Channellist[chanindex].ChannelUserLevel) || thisCon.user.Channellist[conindex].ChannelUserLevel == 5) //ranking check
						{
							// var ch = findChannelByName(msg.channel);
							
							ch.loadPermissionsFromDatabase();
						
							// if(thisCon.user.currentChannel == userToDowngrade.currentChannel)
							// {
							userToDowngrade.Channellist[chanindex].ChannelUserLevel = 1;								
								// ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
							// }
							// else if(thisCon.user.currentChannel == userToDowngrade.prevChannel)
							// {
							// 	userToDowngrade.prevChannel = 1;
							// }
							ch.sendEvent('autodeop', {name: thisCon.user.nickname,target:msg.target,profile:"normal",channel:ch.name});
							// ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + commandParts[1] + " gemaakt op kanaal " + ch.name + " en blijvende rechten afgenomen.");
						}
						else
						{
                            thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
							// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
						}
					}
				}
				else
				{
                    thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "autosoplist")
			{
				var list = "autosops list: ";
				
				if(thisCon.user.accountType == 5 || thisCon.user.accountType == 4)
				{
					simpleQueryCallBack("select * from users where accountType=4 or accountType=5", function(qrows)
					{
						for(var qindex=0; qindex<qrows.length; qindex++)
						{
							list += "<br />" + qrows[qindex].nickname + " heeft blijvende " + convertUserLevelIntToString(qrows[qindex].accountType) + " - rechten gegeven door " + qrows[qindex].rightsBy;
						}
						thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: list});
						// thisCon.con.emit('server message', list);
					});
				}

			}
			else if(msg.command == "killchannel")
			{
				if(thisCon.user.accountType == 5 || thisCon.user.accountType == 4)
				{
					//kill the room!
					
					var roomToKill = msg.channel;
					
					if(!!msg.channel)
					{
						var roomToKillT = findChannelByName(msg.channel);
						
						if(roomToKillT == null)
						{
                            thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Kanaal niet gevonden, of bestaat niet.'});
							// thisCon.con.emit('server message', 'Kanaal niet gevonden, of bestaat niet.');
							return;
						}
						
						roomToKill = roomToKillT.name;
					}
					
					if(roomToKill == "Kletshoek" || roomToKill == "Hulp" || roomToKill == "Sex" || roomToKill == "Trivia" || roomToKill == "Vlaanderen" || roomToKill == "Youtube" )
					{
                        thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Kan door de server gemaakte kanaal niet sluiten'});
						// thisCon.con.emit('server message', 'Kan door de server gemaakte kanaal niet sluiten');
						return;
					}
                    					
					var userChannel = findChannelByName(roomToKill);
					
					//move all chatters to Kletshoek first...
					for(var cIndex=0; cIndex < connections.length; cIndex++)
					{
						if(connections[cIndex] != null)
						{
							if(connections[cIndex].user != null)
							{
								for(var i =0 ; i<connections[cIndex].user.Channellist.length;i++)
								{
									if(connections[cIndex].user.Channellist[i].Channel == roomToKill)
									{
										connections[cIndex].con.emit('event', {'event':'parted',channel:roomToKill,name:connections[cIndex].user.nickname});
										// connections[cIndex].con.emit('changed channel', '');
									
										userChannel.removeFromChannel(connections[cIndex].user);
										//findChannelByName("Kletshoek").addToChannel(connections[cIndex].user);
										connections[cIndex].con.emit('event', {'event': 'channelkilled', name: thisCon.user.nickname, channel: roomToKill});
									}
								}								
							}
						}
					}
					
					for(var chanIndex=0; chanIndex < channels.length; chanIndex++)
					{
						if(channels[chanIndex] != null)
						{
							if(channels[chanIndex].name == roomToKill)
							{
								channels[chanIndex] = null;
							}
						}
					}
					
					executeSimpleQuery("delete from channels where name='" + roomToKill + "';");
					
					//send new channel list to everybody
					for	(index = 0; index < connections.length; index++)
					{
						if(connections[index] != null)
						{
							if(connections[index].user != null)
							{
								connections[index].user.sendChannelList();
							}
						}
					}
				}
				else
				{
                    connections[cIndex].con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Permission Denied.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Permission Denied.'});
				}
			}
			else if(msg.command == "kick")
			{
				//oper, super, cyber, admin, creator from channel
				var conindex;
				for(var j =0 ; j<thisCon.user.Channellist.length;j++)
				{
					if(thisCon.user.Channellist[j].Channel == msg.channel)
					{
						conindex = j;
						break;
					}
				}
				if(conindex == undefined)
				{
					thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
					// thisCon.con.emit('server message', 'That user is not in the channel currently');
					return;
				}
				if((thisCon.user.Channellist[conindex].ChannelUserLevel==7&&findChannelByName(thisCon.user.Channellist[conindex].Channel).prio<5)||thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 2 || thisCon.user.Channellist[conindex].ChannelUserLevel == 5)
				{
					var userToKick = findUserFromStringName(msg.target);
					
					if(userToKick != null)
					{
						var ch = null;
						var chanindex;
						//Next, check if the user is in the same channel as the user attempting the command
						for(var i =0 ; i<userToKick.Channellist.length;i++)
						{
							if(userToKick.Channellist[i].Channel == msg.channel)
							{
								ch = findChannelByName(msg.channel);
								chanindex = i;
								break;
							}
						}

						if(ch == null)
						{
							thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
							// thisCon.con.emit('server message', 'That user is not in the channel currently');
							return;
						}

						if(userToKick.accountType == 4 || userToKick.accountType == 5)
						{
                            thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
							// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
							return;
						}
							if((compareUserLevels(thisCon.user.Channellist[conindex].ChannelUserLevel, userToKick.Channellist[chanindex].ChannelUserLevel) && userToKick.nickname != findChannelByName(userToKick.Channellist[chanindex].Channel).creator) || thisCon.user.Channellist[conindex].ChannelUserLevel == 5)
							{
								// thisCon.con.emit('event', {'event':'parted',channel:userToKick.currentChannel,name:userToKick.nickname});
								// findConnectionFromUser(userToKick).con.emit('changed channel', '');
								
								
								//findChannelByName("Kletshoek").addToChannel(userToKick);
								
								// findChannelByName(thisCon.user.currentChannel).sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToKick.nickname + ' verwijdert uit kanaal ' + thisCon.user.currentChannel);
								findChannelByName(thisCon.user.Channellist[conindex].Channel).sendEvent('kick', {name: thisCon.user.nickname,target:userToKick.nickname,channel:msg.channel, reason:""});
								findChannelByName(thisCon.user.Channellist[conindex].Channel).sendEvent('parted', {channel:msg.channel,name:userToKick.nickname});
								findChannelByName(userToKick.Channellist[chanindex].Channel).removeFromChannel(userToKick);
								sendChannelNumbersToAll();
							}
							else
							{
								thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
								// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
							}
					}
				}
				else
				{
                    thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "ban")
			{
				if(thisCon.user != null)
				{
					var conindex;
					var ch = null;
					for(var j =0 ; j<thisCon.user.Channellist.length;j++)
					{
						if(thisCon.user.Channellist[j].Channel == msg.channel)
						{
							ch = findChannelByName(msg.channel);
							conindex = j;
							break;
						}
					}
					if(conindex == undefined||ch==null)
					{
						thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
						// thisCon.con.emit('server message', 'That user is not in the channel currently');
						return;
					}
					if((thisCon.user.Channellist[conindex].ChannelUserLevel==7&&findChannelByName(thisCon.user.Channellist[conindex].Channel).prio<5)||thisCon.user.Channellist[conindex].ChannelUserLevel == 5 || thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || (thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 2) && findChannelByName(thisCon.user.Channellist[conindex].Channel).creator != msg.target)
					{
						var userToBan = findUserFromStringName(msg.target);
						
						if(userToBan != null)
						{
							var chanindex;
							//Next, check if the user is in the same channel as the user attempting the command
							for(var i =0 ; i<userToBan.Channellist.length;i++)
							{
								if(userToBan.Channellist[i].Channel == msg.channel)
								{
									
									chanindex = i;
									break;
								}
							}

							if(chanindex == undefined)
							{
								thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
								// thisCon.con.emit('server message', 'That user is not in the channel currently');
								return;
							}

							if(compareUserLevels(thisCon.user.Channellist[conindex].ChannelUserLevel, userToBan.Channellist[chanindex].ChannelUserLevel) || thisCon.user.Channellist[conindex].ChannelUserLevel == 5)
							{
								if(userToBan.accountType == 4 || userToBan.accountType == 5)
								{
                                    thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Can not ban cyber/admin accounts.'});
									// thisCon.con.emit('server message', 'Can not ban cyber/admin accounts.');
									return;
								}
								var chanToBanFrom = chan;
								// var chanToBanFrom = findChannelByName(thisCon.user.currentChannel);
							
								simpleQueryCallBack("select * from channelbans where channelName='" + thisCon.user.Channellist[conindex].Channel + "' and nickname='" + userToBan.nickname + "'", function(rows)
								{
									if(rows.length != 0)
									{
                                        thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'That user is already banned'});
										// thisCon.con.emit('server message', 'That user is already banned');
									}
									else
									{
										executeSimpleQuery("insert into channelbans values('" + msg.channel + "', '" + userToBan.nickname + "', '" + thisCon.user.nickname + "')");
										
										chanToBanFrom.banList.push({nickname: userToBan.nickname, bannedBy: thisCon.user.nickname});
										
										if(userToBan.Channellist[chanindex].Channel == chanToBanFrom.name)
										{
											//if the user is in the channel at present, then kick 'em
											findConnectionFromUser(userToBan).con.emit('event', {event:'kick',name: thisCon.user.nickname,target:userToBan.nickname,channel:chanToBanFrom.name, reason:"baned"});
                                            findChannelByName(thisCon.user.Channellist[conindex].Channel).sendEvent('parted', {channel:chanToBanFrom.name,name:userToKick.nickname});
											// findConnectionFromUser(userToBan).con.emit('changed channel', '');
								
											findChannelByName(chanToBanFrom.name).removeFromChannel(userToBan);
											
											//findChannelByName(thisCon.user.currentChannel).sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' verbannen van kanaal ' + thisCon.user.currentChannel);

											sendChannelNumbersToAll();
										}
										chanToBanFrom.sendEvent('servermessage', {name: 'SERVER: ', message: thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' verbannen van kanaal ' + chanToBanFrom.name});
										// chanToBanFrom.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' verbannen van kanaal ' + chanToBanFrom.name);
									}
								});
							}
							else
							{
                                thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
								// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
							}
						}
						else
						{
                            thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Kan niet bannen van Kletshoek'});
							// thisCon.con.emit('server message', 'Kan niet bannen van Kletshoek');
						}
					}
					else
					{
                        thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
						// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					}
				}
			}
			else if(msg.command == "unban")
			{
				if(thisCon.user != null)
				{
					var conindex;
					var ch = null;
					for(var j =0 ; j<thisCon.user.Channellist.length;j++)
					{
						if(thisCon.user.Channellist[j].Channel == msg.channel)
						{
							ch = findChannelByName(msg.channel);
							conindex = j;
							break;
						}
					}
					if(conindex == undefined||ch==null)
					{
						thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
						// thisCon.con.emit('server message', 'That user is not in the channel currently');
						return;
					}
					if((thisCon.user.Channellist[conindex].ChannelUserLevel==7&&findChannelByName(thisCon.user.Channellist[conindex].Channel).prio<5)||thisCon.user.Channellist[conindex].ChannelUserLevel == 5 || thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 2)
					{
						var userToUnBan = findUserFromStringName(msg.target);
						
						if(userToUnBan != null)
						{

							var chanToUnBanFrom = findChannelByName(msg.channel);
						
							simpleQueryCallBack("select * from channelbans where channelName='" + msg.channel + "' and nickname='" + userToUnBan.nickname + "'", function(rows)
							{
								if(rows.length == 0)
								{
                                    thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Gebruiker is niet verbannen!'});
									// thisCon.con.emit('server message', 'Gebruiker is niet verbannen!');
								}
								else
								{
									executeSimpleQuery("delete from channelbans where channelName='" + msg.channel + "' and nickname='" + userToUnBan.nickname + "'");
									
									for(var banIndex=0; banIndex<chanToUnBanFrom.banList.length; banIndex++)
									{
										if(chanToUnBanFrom.banList[banIndex] != null)
										{
											if(chanToUnBanFrom.banList[banIndex].nickname == userToUnBan.nickname)
											{
												chanToUnBanFrom.banList[banIndex] = null;
											}
										}
									}
									
                                    //let the user know they've been unbanned
                                    // findConnectionFromUser(userToUnBan).con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: thisCon.user.nickname + ' unbanned ' + userToUnBan.nickname + ' from ' + chanToUnBanFrom.name});
									// findConnectionFromUser(userToUnBan).con.emit('server message', thisCon.user.nickname + ' unbanned ' + userToUnBan.nickname + ' from ' + chanToUnBanFrom.name);
									chanToUnBanFrom.sendEvent('UNBAN', {name: thisCon.user.nickname,target:userToUnBan.nickname,channel:msg.channel});
									// chanToUnBanFrom.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUnBan.nickname + ' toegang gegeven op kanaal ' + chanToUnBanFrom.name);
								}
							});
						}
						else
						{
                            thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Gebruiker is niet verbannen!'});
							// thisCon.con.emit('server message', 'Gebruiker niet online');
						}
					}
					else
					{
                        thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
						// thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					}
				}
			}
			else if(msg.command == "banlist")
			{
				if(thisCon.user != null)
				{
					var conindex;
					var ch = null;
					for(var j =0 ; j<thisCon.user.Channellist.length;j++)
					{
						if(thisCon.user.Channellist[j].Channel == msg.channel)
						{
							ch = findChannelByName(msg.channel);
							conindex = j;
							break;
						}
					}
					if(conindex == undefined||ch==null)
					{
						thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
						// thisCon.con.emit('server message', 'That user is not in the channel currently');
						return;
					}
					if((thisCon.user.Channellist[conindex].ChannelUserLevel==7&&findChannelByName(thisCon.user.Channellist[conindex].Channel).prio<5)||thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 2 ||  thisCon.user.Channellist[conindex].ChannelUserLevel == 5)
					{
						var currentC = findChannelByName(msg.channel);
						var mess = [];
						
						for(var banIndex=0; banIndex<currentC.banList.length; banIndex++)
						{
							if(currentC.banList[banIndex] != null)
							{
								mess.push({target:currentC.banList[banIndex].nickname,bantime,banner:currentC.banList[banIndex].bannedBy});
							}
						}
                        thisCon.con.emit('event', {'event': 'banlist', channel: msg.channel, bans: mess});
						// thisCon.con.emit('server message', mess);
					}
					else
					{
						thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					}
				}
			}
			else if(msg.command == "quit")
			{
				socket.disconnect();
			}
			else if(msg.command == "skick")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 5) //only admin/cyber user
				{
					var userToKick = findUserFromStringName(msg.target);
					
					if(userToKick != null)
					{
						if(userToKick.accountType >= userToKick.accountType)
						{
                            
                            sendEventToAllLoggedInUsers('skick', {name:thisCon.user.nickname, target: userToKick.nickname,reason:""});
							// sendEventToAllLoggedInUsers('server message', thisCon.user.nickname + ' heeft ' + userToKick.nickname + ' verwijdert van de chat server.');
							
							findConnectionFromUser(userToKick).con.disconnect();
						}
					}
				}
				else
				{
					thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "sban")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 5) //only admin/cyber user
				{
					var userToBan = findUserFromStringName(msg.target);
					
					if(userToBan != null)
					{
						if(thisCon.user.accountType >= userToBan.accountType)
						{
							var forTime = "72h";
						
							if(commandParts.length == 3)
							{
						
								forTime = msg.bantime;
							
							}
							
							var forSymbol = 'hour';
							
							if(forTime[forTime.length - 1] == 'm') { forSymbol = 'minute' };
							
							var banUntil = dateAdd(Date.now(), forSymbol, parseInt(forTime.substring(0, forTime.length - 1)));
							
							executeSimpleQuery("insert into serverbans values('" + userToBan.nickname + "', '" + thisCon.user.nickname + "', " + Number(banUntil) + ", '" + userToBan.ip + "')");
							sendEventToAllLoggedInUsers('sban', {name: thisCon.user.nickname, message: userToBan.nickname,reason:banUntil.toString()});
							// sendEventToAllLoggedInUsers('server message', thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' uitgesloten van de chat server tot ' + banUntil.toString());
							
							findConnectionFromUser(userToBan).con.disconnect();
						}
					}
					else
					{
                        thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Gebruiker niet online.'});
						// thisCon.con.emit('server message', 'Gebruiker niet online.');
					}
				}
				else
				{
					thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "sbanlist")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 5) //only admin/cyber user
				{	
					simpleQueryCallBack("select * from serverbans;", function(sRows)
					{
						var list = [];
						
						for(var sIndex=0; sIndex < sRows.length; sIndex++)
						{
							list.push({target: sRows[sIndex].nickname, bantime: (new Date(sRows[sIndex].unbanTimestamp)).toString(), banner: sRows[sIndex].bannedBy,ip:sRows[sIndex].ip});
						}
						thisCon.con.emit('event', {'event': 'sbanlist', bans: list});
						// thisCon.con.emit('server message', list);
					});
				}
				else
				{                    
					thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Permission Denied.'});
				}
			}
			else if(msg.command == "sunban")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 5) //only admin/cyber user
				{
					simpleQueryCallBack("select * from serverbans where nickname='" + msg.target + "'", function(bRows)
					{
						if(bRows.length != 0)
						{
                            executeSimpleQuery("delete from serverbans where nickname='" + msg.target + "'");
                            
                            thisCon.con.emit('event', {'event': 'sunban', name: thisCon.user.nickname, target: msg.target});
							// thisCon.con.emit('server message', 'Gebruiker heeft weer toegang tot de chat server ' + msg.target);
						}
						else
						{
                            thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Gebruiker is niet uitgesloten van de chat server'});
							// thisCon.con.emit('server message', 'Gebruiker is niet uitgesloten van de chat server');
						}
					});
				}
				else
				{
					thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == "version")
			{
                thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: "Current version is: " + version});
				// thisCon.con.emit('server message', "Current version is: " + version);
			}
			else if(msg.command == "info")
			{
                thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: "Chat Server owned by: Sunto<br />Coded By: PAM"});
				// thisCon.con.emit('server message', "Chat Server owned by: Sunto<br />Coded By: joehollo");
			}
			
			else if(msg.command == "topic")
			{
				if(thisCon.user != null)
				{
					var conindex;
					var ch = null;
					for(var j =0 ; j<thisCon.user.Channellist.length;j++)
					{
						if(thisCon.user.Channellist[j].Channel == msg.channel)
						{
							ch = findChannelByName(msg.channel);
							conindex = j;
							break;
						}
					}
					if(conindex == undefined||ch==null)
					{
						thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
						// thisCon.con.emit('server message', 'That user is not in the channel currently');
						return;
					}
					if(thisCon.user.Channellist[conindex].ChannelUserLevel == 5 || thisCon.user.Channellist[conindex].ChannelUserLevel == 4 || thisCon.user.Channellist[conindex].ChannelUserLevel == 3 || thisCon.user.Channellist[conindex].ChannelUserLevel == 2)
					{
						var thisCh = findChannelByName(thisCon.user.Channellist[conindex].ChannelUserLevel);
						
						var parsedTopic = "";
						var topicParts = msg.replace("/topic ", "").split(" ");
						
						var firstCol = true;
						
						for(var partsIndex=0; partsIndex<topicParts.length; partsIndex++)
						{
							if(/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(topicParts[partsIndex]))
							{
								if(firstCol == true)
								{
									firstCol = false;
								}
								else
								{
									parsedTopic += "</span>";
								}
								
								parsedTopic += "<span style=\"color: " + topicParts[partsIndex] + "\">";
							}
							else
							{
								parsedTopic += " " + topicParts[partsIndex];
							}
						}
						
						if(firstCol == false)
						{
							parsedTopic += "</span>";
						}
						
						thisCh.topic = parsedTopic;
						
						thisCh.sendEvent('channel topic update', thisCh.topic);
						thisCh.sendEvent('server message', thisCon.user.nickname + ' heeft de topic verandert');
						thisCh.sendEvent('server message', 'Nieuw Topic: ' + thisCh.topic);
					}
					else
					{
						thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
					}
				}
			}			
			else if(msg.command == 'hide')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 5) //only admin/cyber user
				{
					if(thisCon.user.xcdrvesl == false)
					{
						var ch = findChannelByName(msg.channel);
						ch.sendEvent('hide', {'event':'hide',channel:msg.channel,name:thisCon.user.nickname});
						// ch.sendEvent('user left channel', thisCon.user.nickname);
						thisCon.user.xcdrvesl = true;
						ch.currentUsers--;
						
						
						sendChannelNumbersToAll();
					}
				}
			}
			else if(msg.command == 'unhide')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 5) //only admin/cyber user
				{
					if(thisCon.user.xcdrvesl == true)
					{
                        var ch = findChannelByName(msg.channel);
                        ch.sendEvent('unhide', {event: 'unhide', name: thisCon.user.nickname, channel: msg.channel, profile: convertUserLevelIntToString(thisCon.user.accountType)});
						// ch.sendEvent('user joined channel', JSON.stringify(thisCon.user));
						thisCon.user.xcdrvesl = false;
						ch.currentUsers++;
						
						sendChannelNumbersToAll();
					}
				}
			}
			else if(msg.command == 'slog')
			{
				if(thisCon.user.accountType == 5)
				{
					simpleQueryCallBack("select * from errors", function(erows)
					{
						var elog = "Error Log: ";
						
						for(var c=0; c<erows.length; c++)
						{
							elog += "<br /><br />" + erows[c].timestamp + ": " + erows[c].error + "<br />" + erows[c].stacktrace;
						}
						thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: elog});
						// socket.emit('clog', elog);
					});
				}
			}
			else if(msg.command == 'clog')
			{
				if(thisCon.user.accountType == 4)
				{
					socket.emit('clog', findChannelByName(thisCon.user.currentChannel).clog);
				}
			}
			else if(msg.command == 'cleanlog')
			{
				if(thisCon.user.accountType == 4)
				{
					findChannelByName(thisCon.user.currentChannel).clog = "";
					executeSimpleQuery("update chatlogs set text='' where channelName='" + thisCon.user.currentChannel + "'");
					socket.emit('server message', 'Log van kanaal geleegd');
				}
			}
			else if(msg.command == 'silent')
			{
				if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3)
				{
					var userToSilence = findUserFromStringName(msg.target);
					
					if(userToSilence != null)
					{
						if(compareUserLevels(thisCon.user.currentChannelUserLevel, userToSilence.currentChannelUserLevel))
						{
							if(userToSilence.currentChannel == thisCon.user.currentChannel)
							{
                                userToSilence.bhdedl = true;
                                findChannelByName(userToSilence.currentChannel).sendEvent('servermessage', {'event': 'servermessage', name: 'SERVER: ', message: thisCon.user.nickname + ' has silent ' + userToSilence.nickname + ' on channel ' + userToSilence.currentChannel});
								// findChannelByName(userToSilence.currentChannel).sendEvent('server message', thisCon.user.nickname + ' has silent ' + userToSilence.nickname + ' on channel ' + userToSilence.currentChannel);
								// findChannelByName(userToSilence.currentChannel).sendEvent('user updated', JSON.stringify(userToSilence));
							}
						}
						else
						{
							thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
						}
					}
				}
				else
				{
					thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == 'unsilent')
			{
				if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3)
				{
					var userToSilence = findUserFromStringName(msg.target);
					
					if(userToSilence != null)
					{
						if(userToSilence.currentChannel == thisCon.user.currentChannel)
						{
                            userToSilence.bhdedl = false;
                            findChannelByName(userToSilence.currentChannel).sendEvent('servermessage', {'event': 'servermessage', name: 'SERVER: ', message: thisCon.user.nickname + ' have unsilenced ' + userToSilence.nickname + ' on ' + userToSilence.currentChannel});
							// findChannelByName(userToSilence.currentChannel).sendEvent('server message', thisCon.user.nickname + ' have unsilenced ' + userToSilence.nickname + ' on ' + userToSilence.currentChannel);
							// findChannelByName(userToSilence.currentChannel).sendEvent('user updated', JSON.stringify(userToSilence));
						}
					}
				}
				else
				{
					thisCon.con.emit('event', {'event': 'servermessage', name: 'SERVER: ', message: 'Deze actie is niet toegestaan.'});
				}
			}
			else if(msg.command == 'autooplist')
			{
					var conindex;
					var ch = null;
					for(var j =0 ; j<thisCon.user.Channellist.length;j++)
					{
						if(thisCon.user.Channellist[j].Channel == msg.channel)
						{
							ch = findChannelByName(msg.channel);
							conindex = j;
							break;
						}
					}
					if(conindex == undefined||ch==null)
					{
						thisCon.con.emit('event', {'event': 'error', name: 'SERVER: ', message: 'the user you specified is not in this channel at present.', color: 'red' });
						// thisCon.con.emit('server message', 'That user is not in the channel currently');
						return;
					}
				var list=[];
				
				// var ch=findChannelByName(msg.channel);
				
				
				simpleQueryCallBack("select nickname, givenBy, level from channelrights where channelName='" + msg.channel + "'", function(oprows)
				{
					for(var opIndex=0; opIndex<oprows.length; opIndex++)
					{
						list.push({target:oprows[opIndex].nickname,profile:convertUserLevelIntToString(oprows[opIndex].level),giver:oprows[opIndex].givenBy});
					}
					thisCon.con.emit('event', {'event': 'autooplist', channel: msg.channel, autoops: list});
				});
			}
			else if(msg.command == 'allusers')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3)
				{
					var list="all online users are:";
					
					for(var conIndex=0; conIndex < connections.length; conIndex++)
					{
						if(connections[conIndex] != null)
						{
							list += "<br />" + connections[conIndex].user.nickname + " in " + connections[conIndex].user.currentChannel;
						}
					}
					
					thisCon.con.emit('server message', list);
				}
			}
			else if(msg.command == 'makestatic')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3)
				{
					findChannelByName(thisCon.user.currentChannel).staticC = true;
					executeSimpleQuery("update channels set isStatic=1 where name='" + thisCon.user.currentChannel + "'");
					thisCon.con.emit('server message', 'Made ' + thisCon.user.currentChannel + ' static.');
				}
			}
			else
			{
				thisCon.con.emit('sever message', 'Deze actie is niet toegestaan.');
			}
		}
	});
});

function convertUserLevelIntToString(uli)
{
	if(uli == 0)
	{
		return "Silent";
    }
    else if(uli == 1)
	{
		return "normal";
	}
	else if(uli == 2)
	{
		return "oper";
	}
	else if(uli == 3)
	{
		return "super";
	}
	else if(uli == 4)
	{
		return "cyber";
	}
	else if(uli == 5)
	{
		return "admin";
    }
    else if(uli == 6)
	{
		return "Jarig";
    }
    else if(uli == 7)
	{
		return "Bot";
	}
	
	return null;
}

//if one is higher than two return true
function compareUserLevels(one, two)
{
	if(one == 4 && two == 5)
	{
		return true;
	}
	else if(one == 5 && two == 4)
	{
		return false;
	}
	
	return (one > two);
}

function convertUserLevelStringToInt(uls)
{
	//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator

	if(uls == "Silent")
	{
		return 0;
    }
    else if(uls == "normal")
	{
		return 1;
	}
	else if(uls == "oper")
	{
		return 2;
	}
	else if(uls == "super")
	{
		return 3;
	}
	else if(uls == "cyber")
	{
		return 4;
	}
	else if(uls == "admin")
	{
		return 5;
	}
	else if(uls == "creator")
	{
		return 3;
    }
    else if(uls == "jarig"||uls == "Jarig")
	{
		return 6;
    }
    else if(uls == "vip"||uls == "VIP")
	{
		return 6;
    }
    else if(uls == "bot"||uls == "Bot")
	{
		return 7;
	}
}

//Class definitions:

//Represents a connection to the server, .user can be null if they are not yet logged in
function Connection(user, con, ip)
{
	this.user = user;
	this.con = con;
	this.ip = ip;
}

//Represents a User of the chat system
function User(nickname, accountType, age, gender, location, additionalInfo, email, profileImage, isGuest)
{
	this.nickname = nickname;
	this.accountType = accountType; //Simple int - 0 = standard user, 1 = admin
	this.age = age;
	this.gender = gender;
	this.location = location;
	this.additionalInfo = additionalInfo;
	this.email = email;
	
	this.ip = "";
	
	this.guest = isGuest;

	this.lastActive = Date.now();
	
	this.xcdrvesl = false;
	this.bhdedl = false;
	
	this.profileImage = profileImage;
	this.Channellist = [];//{Channel:,ChannelUserLevel}
	this.prevChannel = "";
	this.currentChannel = "";
	this.prevChannelUserLevel = accountType;
	//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
	this.currentChannelUserLevel = accountType;  //will be either 0 or 4 from database for user (as only admin/normal apply to entire chat.)
	this.userWhoGave = "";
	
	this.loggedIn = Date.now();
	
	//Methods
	this.kick = kick;
	this.sendPrivateMessage = sendPrivateMessage;
	this.sendChannelList = sendChannelList;
	this.sendInitialChannelUsers = sendInitialChannelUsers;
}

//Function to kick a User
function kick(reason)
{
	var usersConnection = findConnectionFromUser(this);
	usersConnection.con.emit('kicked', reason);
	usersConnection.disconnect();
}

//Function to send a private message to a User
function sendPrivateMessage(privateMessage)
{
	var usersConnection = findConnectionFromUser(this);
	usersConnection.con.emit('privatemessage', JSON.stringify(privateMessage));
}

//Function to send the channel list to this user
function sendChannelList()
{
	var channelArr = [];
	
	for(index=0; index < channels.length; index++)
	{
		if(channels[index] != null)
		{
			//if((channels[index].type == 1 && (this.accountType == 4 || this.accountType == 3)) || (channels[index].type == 0))
			//{
				channelArr.push(channels[index]);
			//}
		}
	}
	findConnectionFromUser(this).con.emit('event', {event: 'channellist', channels: channelArr, hjoin: false});
}

//Function to send the users in the current channel to this user
function sendInitialChannelUsers()
{
    
	
	for(var conindex = 0; conindex<this.Channellist.length; conindex++)
	{
		var numClients = 0;
		var usersArr = [];
		for	(var index = 0; index < connections.length; index++)
		{
			if(connections[index] != null && connections[index].con != null)
			{
				if(connections[index].user != null)
				{
					for(var chanindex = 0;chanindex<connections[index].user.Channellist.length;chanindex++)
					{
						if(connections[index].user.Channellist[chanindex].Channel == this.Channellist[conindex].Channel)
						{
							// if(connections[index].user.xcdrvesl == false)
							// {
								numClients++;
								usersArr.push({name: connections[index].user.nickname,profile:convertUserLevelIntToString(connections[index].user.Channellist[chanindex].ChannelUserLevel)});
							// }
						}
					}
				}
			}
		}
		var chattercounts = (typeof connections !== 'undefined') ? Object.keys(connections).length : 0;
		findConnectionFromUser(this).con.emit('event', {
			'event': 'userlist',
			'channel': this.Channellist[conindex].Channel,
			'chattercount': chattercounts,
			'channelcount': numClients,
			'users': usersArr
		});
	}

    
	// findConnectionFromUser(this).con.emit('channel users list', JSON.stringify(usersArr));
}

//Represents a Channel
function Channel(name, creator, topic, type, logg, statChan)
{
	this.name = name;
	this.creator = creator;
	this.topic = topic;
	this.prio = type; //Simple int - 0=normal, 1=admin
	this.currentUsers = 0;
	this.staticC = statChan;
	
	//Store values for temporary admin positions
	//Stored in form of {nickname, nicknameOfUserWhoGranted}
	//this.tempSuperAdmins = [];
	//this.tempCyberStatus = [];
	//this.tempOperators = [];  //removed because of a change in how it's stored
	
	//Store values for permenant admin positions 
	this.permSuperAdmins = [];
	this.permOperators = [];
	this.banList = [];
	this.userList  = [];
	//Store chat log
	this.clog = logg;
	this.clogSaveCount = 0;
	
	//methods:
	this.sendEvent = sendEvent;
	this.sendMessage = sendMessage;
	this.addToChannel = addToChannel;
	this.removeFromChannel = removeFromChannel;
	this.loadPermissionsFromDatabase = loadPermissionsFromDatabase;
	this.loadClogFromDatabase = loadClogFromDatabase;
	this.loadBanListFromDatabase = loadBanListFromDatabase;
	this.sendServerMessage = sendServerMessage;
}

//Function to send an event to all users of a channel
function sendEvent(eventName, contents)
{
    contents['event'] =  eventName;
    console.log(contents);
	console.log(this.name);
	
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				console.log(connections[index].user.Channellist);
				for(var chanindex = 0; chanindex<connections[index].user.Channellist.length;chanindex++)
				{
					if(connections[index].user.Channellist[chanindex].Channel == this.name)
					{
						
						connections[index].con.emit('event', contents);
					}
				}
			}
		}
	}
}

//Function to send server message to this channel i.e. < message >
function sendServerMessage(message)
{
	this.sendEvent('servermessage', message);
}

//Function to send a message to all users of a channel
function sendMessage(messageToSend)
{	
	this.clog += "<br />" + messageToSend.sender + " : " + messageToSend.content;
	this.clogSaveCount++;
	
	if(this.clogSaveCount == 100)
	{
		//save the log to the database every 100 messages
		executeSimpleQuery("update chatlogs set text='" + this.clog + "' where channelName='" + this.name + "';");

		this.clogSaveCount = 0;
	}
	
	this.sendEvent('channelmessage', {
        message: messageToSend.content,
        name: messageToSend.sender,
        channel: this.name,
        color: messageToSend.color
    });
}

//Function to call when a user joins the channel, will notify all channel users of their joining
function addToChannel(user)
{
	for(var banIndex=0; banIndex < this.banList.length; banIndex++)
	{
		if(this.banList[banIndex] != null)
		{
			if(this.banList[banIndex].nickname == user.nickname)
			{
                //don't add the user to channel				
                findConnectionFromUser(user).con.emit('event', {event:'parted',channel:this.name,name:user.nickname});
				// findConnectionFromUser(user).con.emit('changed channel', '');
				
				// findConnectionFromUser(user).con.emit('server message', 'Je bent verbannen van dit kanaal.');
				
				return;
			}
		}
	}

	
	//Send a JSON version of the User that's joined, so that the members of the channel have all of their info
	//for the pop up box that appears when we hover over their name...
	
	if(user.xcdrvesl == false)
	{
		this.currentUsers++;
	}
	
	var foundUserPermissions = user.accountType;
	
	if(foundUserPermissions != 5 && foundUserPermissions != 4) //don't search for permissions if the user is already an admin OR cyberhost
	{	
		//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator, 5=creator
		
		/*for(var tempOperatorsIndex=0; tempOperatorsIndex<this.tempOperators.length; tempOperatorsIndex++)
		{
			if(this.tempOperators[tempOperatorsIndex].nickname == user.nickname)
			{
				foundUserPermissions = 1;
				break;
			}
		}*/
		
		for(var permOperatorsIndex=0; permOperatorsIndex<this.permOperators.length; permOperatorsIndex++)
		{
			if(this.permOperators[permOperatorsIndex] != null)
			{
				if(this.permOperators[permOperatorsIndex].nickname == user.nickname)
				{
					foundUserPermissions = 1;
					break;
				}
			}
		}
		
		/*for(var tempSuperAdminsIndex=0; tempSuperAdminsIndex<this.tempSuperAdmins.length; tempSuperAdminsIndex++)
		{
			if(this.tempSuperAdmins[tempSuperAdminsIndex].nickname == user.nickname)
			{
				foundUserPermissions = 2;
				break;
			}
		}*/
		
		for(var permSuperAdminsIndex=0; permSuperAdminsIndex<this.permSuperAdmins.length; permSuperAdminsIndex++)
		{
			if(this.permSuperAdmins[permSuperAdminsIndex] != null)
			{
				if(this.permSuperAdmins[permSuperAdminsIndex].nickname == user.nickname)
				{
					foundUserPermissions = 3;
					break;
				}
			}
		}
		
		if(this.creator == user.nickname)
		{
			foundUserPermissions = 3;
		}
	}
	
	user.Channellist.push({Channel:this.name,ChannelUserLevel:foundUserPermissions});
	if(user.xcdrvesl == false)
	{
        var numClients = (typeof connections !== 'undefined') ? Object.keys(connections).length : 0;
        var channelcounts = (typeof channels !== 'undefined') ? Object.keys(channels).length : 0;
        
		this.sendEvent('joined', {name: user.nickname, channel: this.name,profile:convertUserLevelIntToString(foundUserPermissions),'chattercount': this.currentUsers, 'channelcount': numClients, hidden: false});
        // this.sendEvent('servermessage', {name:"server",message:user.nickname + ' komt kanaal (' + user.currentChannel + ') binnen',color:'red'});	
    }

	
	user.sendInitialChannelUsers();
	
	sendChannelNumbersToAll();
	
	if(this.staticC == 0)
	{
		findConnectionFromUser(user).con.emit('servermessage', user.nickname + ' welkom op kanaal (' + this.name + ')<br />dit kanaal is aangemaakt door: ' + this.creator);
	}
	
	findConnectionFromUser(user).con.emit('servermessage', '<b>Kanaal Topic:</b> ' + this.topic);
}

//Function to call when a user leaves the channel, will notify all channel users they have left
function removeFromChannel(user)
{
	//Just send the User's nickname instead of a full JSON version
	
	if(user.xcdrvesl == false)
	{
		this.currentUsers--;
	}
	for(var chanindex=0; chanindex<user.Channellist.length;chanindex++)
	{
		if(user.Channellist[chanindex].Channel == this.name)
		{
			console.log(user.Channellist);
			user.Channellist.splice(chanindex,1);
			console.log(user.Channellist);
			break;
		}
	}
	// user.currentChannelUserLevel = user.accountType;
	// user.currentChannel = "";
	
	user.lastActive = Date.now();
	
	if(user.xcdrvesl == false)
	{
		this.sendEvent('user left channel', user.nickname);
		this.sendEvent('server message', user.nickname + ' verlaat kanaal (' + this.name + ')');
	}
	
	if(this.currentUsers == 0)
	{
		//channel is now empty so...
		
		if(this.staticC == 0)
		{
			//kill the channel
			
			for(var chanIndex=0; chanIndex < channels.length; chanIndex++)
			{
				if(channels[chanIndex] != null)
				{
					if(channels[chanIndex].name == this.name)
					{
						channels[chanIndex] = null;
					}
				}
			}
			
			executeSimpleQuery("delete from channels where name='" + this.name + "';");
			
			//send new channel list to everybody
			for	(index = 0; index < connections.length; index++)
			{
				if(connections[index] != null)
				{
					if(connections[index].user != null)
					{
						connections[index].user.sendChannelList();
					}
				}
			}
		}
	}
	else
	{
		sendChannelNumbersToAll();
	}
}

function loadPermissionsFromDatabase()
{	
	var currentC = this;

	this.permSuperAdmins = [];
	this.permOperators = [];
	
	pool.getConnection(function(err,connection){
	
        if (err) {
          connection.release();
          console.log("database error: " + err);
        }
       
        connection.query("select * from channelrights where channelName='" + currentC.name + "';",function(err,rows){
            connection.release();
            if(!err) {
				for (var i2 = 0; i2 < rows.length; i2++)
				{
					//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
					
					if(rows[i2].level == 1)
					{
						currentC.permOperators.push( { nickname: rows[i2].nickname, givenBy: rows[i2].givenBy } );
						console.log("perm oper on " + currentC.name + ": " + rows[i2].nickname);
					}
					else if(rows[i2].level == 2)
					{
						currentC.permSuperAdmins.push( { nickname: rows[i2].nickname, givenBy: rows[i2].givenBy } );
						console.log("perm super on " + currentC.name + ": " + rows[i2].nickname);
					}
					else if(rows[i2].level == 3)
					{
						currentC.permCyberStatus.push( { nickname: rows[i2].nickname, givenBy: rows[i2].givenBy } );
						console.log("perm cyber on " + currentC.name + ": " + rows[i2].nickname);
					}
				}
			
				channels.push(currentC);
				currentC.loadBanListFromDatabase();
				currentC.loadClogFromDatabase();
            }
        });
  });
}

function loadClogFromDatabase()
{
	var currentC = this;
	
	simpleQueryCallBack("select * from chatlogs where channelName='" + this.name + "'", function(dcRows)
	{
        // if(!!dcRows[0].text)
    	// 	currentC.clog = dcRows[0].text;
		console.log("Loaded clog for " + currentC.name);
	});
}

//Load the banlist from the database
function loadBanListFromDatabase()
{	
	var currentC = this;

	this.banList = [];
	
	pool.getConnection(function(err,connection){
	
        if (err) {
          connection.release();
          console.log("database error: " + err);
        }
       
        connection.query("select * from channelbans where channelName='" + currentC.name + "';",function(err,rows){
            connection.release();
            if(!err) {
				for (var i2 = 0; i2 < rows.length; i2++)
				{
					//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
					
					currentC.banList.push({nickname: rows[i2].nickname, bannedBy: rows[i2].bannedBy});
					
				}
				
				console.log("finished loading " + currentC.name + " banlist from database");
				console.log("finished loading " + currentC.name + " from database");
            }
        });
  });
}

//Represents a Message
function Message(sender, colour, content, raw)
{
	this.sender = sender; //the user that sent this message - n.b. a string version of their nickname, not an actual User object.
	this.colour = colour; //hex colour for the message
	this.timestamp = getTimeString(); //the current time
	this.content = content;
	if (raw) this.raw = raw;
	else this.raw = false;
}

//Other helper functions etc.

function getTimeString()
{
    var date = new Date();

    var hour = date.getHours();
    hour = (hour < 10 ? "0" : "") + hour;

    var min  = date.getMinutes();
    min = (min < 10 ? "0" : "") + min;

    var sec  = date.getSeconds();
    sec = (sec < 10 ? "0" : "") + sec;

    var year = date.getFullYear();

    var month = date.getMonth() + 1;
    month = (month < 10 ? "0" : "") + month;

    var day  = date.getDate();
    day = (day < 10 ? "0" : "") + day;

    return hour + ":" + min + ":" + sec;
}

function findConnectionFromUser(userToFind)
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user == userToFind)
				{
					return connections[index];
				}
			}
		}
	}
}

function findUserFromStringName(nickToFind)
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user.nickname == nickToFind)
				{
					return connections[index].user;
				}
			}
		}
	}
	
	return null;
}

function removeConnection(con)
{
	for	(rIndex = 0; rIndex < connections.length; rIndex++)
	{
		if(connections[rIndex] != null)
		{
			if(connections[rIndex] == con)
			{
				//If the connection is held by a logged in user, then remove them from whichever room they happen to be in
				if(connections[rIndex].user != null)
				{
					for(var chanindex = 0; chanindex<con.user.Channellist.length; chanindex++)
					{
						findChannelByName(con.user.Channellist[chanindex].Channel).removeFromChannel(con.user);
					}
				}
				connections[rIndex] = null;
			}
		}
	}
	
	sendChannelNumbersToAll();
}

function findConnectionBySocket(socket)
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null && connections[index].con != null)
		{
			if(connections[index].con == socket)
			{
				return connections[index];
			}
		}
	} 
}

function findChannelByName(name)
{
	for	(index = 0; index < channels.length; index++)
	{
		if(channels[index] != null)
		{
			if(channels[index].name == name)
			{
				return channels[index];
			}
		}
	}
	
	return null;
}

function isUserLoggedIn(nickname) //takes a string nickname, NOT a User object
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null && connections[index].con != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user.nickname == nickname)
				{
					return true;
				}
			}
		}
	}
	
	return false;
}

function sendChannelNumbersToAll()
{
    var channellist =[];
    for (var schannel in channels) {
        var rch  = channels[schannel];
        rch['usercount'] = channels[schannel].currentUsers;
        channellist.push(rch);
    }
    // thisCon.con.emit('event', {event: 'channellist', channels: channellist, hjoin: false});
	// var chanNumberString = "";
	
	// for	(index = 0; index < channels.length; index++)
	// {
	// 	if(channels[index] != null)
	// 	{
	// 		chanNumberString = chanNumberString + channels[index].name + ":" + channels[index].currentUsers + "|";
	// 	}
	// }
	
	// chanNumberString = chanNumberString.substring(0, chanNumberString.length - 1);
	for	(var index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user.Channellist.length == 0)
					connections[index].con.emit('event',{event:'channellist',channels: channellist, hjoin: false} );
				connections[index].user.sendInitialChannelUsers();
			}
		}
	}
	// sendEventToAllLoggedInUsers('channellist', {channels: channellist, hjoin: false});
}

function sendEventToAllLoggedInUsers(eventName, contents)
{
    contents['event'] = eventName;
    console.log(contents);
	for	(var index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				connections[index].con.emit('event', contents);
			}
		}
	}
}

function processMessageContent(content, callback) {
	content = content.trim();
	// detect youtube
	var regex = new RegExp(/^http(?:s)?:\/\/(?:www\.)?youtube.com\/watch\?(?=.*v=[a-zA-Z0-9-_]+)(?:\S+)?$/);

	if (regex.test(content)) {
		var youtubeInfoUrl = 'http://www.youtube.com/oembed?url=' + content + '&format=json';
		request(youtubeInfoUrl, function (error, response, body) {
			if (!error && response.statusCode == 200) {
				if (typeof callback == 'function') {
					var info = JSON.parse(body);
					
					var msg = '<a class="youtube-link" href="' + content + '" target="_blank">' + info.title + '</a>';
					
					if (typeof callback == 'function') {
						callback(msg, true);
					}
				} else {
					if (typeof callback == 'function') {
						callback(content, false);
					}
				}
			}
		});
		
	} else {
		if (typeof callback == 'function') {
			callback(content, false);
		}
	}
	
	//return validator.escape(content);
}

function sendServerMessageToAllLoggedInUsers(message)
{
	sendEventToAllLoggedInUsers('servermessage', message);
}

//Error Handling so server won't go down on unexpected input etc.
process.on('uncaughtException', function (err)
{
	console.log('Caught exception: ' + err);
	console.log(err.stack);
	
	executeSimpleQuery("insert into errors values('" + Date.now() + "', '" + err + "', '" + err.stack + "')");
});

function dateAdd(date, interval, units) {
  var ret = new Date(date); //don't change original date
  switch(interval.toLowerCase()) {
    case 'year'   :  ret.setFullYear(ret.getFullYear() + units);  break;
    case 'quarter':  ret.setMonth(ret.getMonth() + 3*units);  break;
    case 'month'  :  ret.setMonth(ret.getMonth() + units);  break;
    case 'week'   :  ret.setDate(ret.getDate() + 7*units);  break;
    case 'day'    :  ret.setDate(ret.getDate() + units);  break;
    case 'hour'   :  ret.setTime(ret.getTime() + units*3600000);  break;
    case 'minute' :  ret.setTime(ret.getTime() + units*60000);  break;
    case 'second' :  ret.setTime(ret.getTime() + units*1000);  break;
    default       :  ret = undefined;  break;
  }
  return ret;
}
function sha1hash(msg) {
    {

        //
// function 'f' [§4.1.1]
//
        function f(s, x, y, z)
        {
            switch (s) {
                case 0: return (x & y) ^ (~x & z);           // Ch()
                case 1: return x ^ y ^ z;                    // Parity()
                case 2: return (x & y) ^ (x & z) ^ (y & z);  // Maj()
                case 3: return x ^ y ^ z;                    // Parity()
            }
        }

//
// rotate left (circular left shift) value x
// by n positions [§3.2.5]
//
        function ROTL(x, n)
        {
            return (x<<n) | (x>>>(32-n));
        }

//
// extend Number class with a tailored hex-string method
//   (note toString(16) is implementation-dependant, and
//   in IE returns signed numbers when used on full words)
//
        Number.prototype.toHexStr = function()
        {
            var s="", v;
            for (var i=7; i>=0; i--) {
                v = (this>>>(i*4)) & 0xf; s += v.toString(16); }
            return s;
        };




        // constants [§4.2.1]
        var K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];


        // PREPROCESSING

        // add trailing '1' bit to string [§5.1.1]
        msg += String.fromCharCode(0x80);

        // convert string msg into 512-bit/16-integer
        // blocks arrays of ints [§5.2.1]

        // long enough to contain msg plus 2-word length
        var l = Math.ceil(msg.length/4) + 2;
        // in N 16-int blocks
        var N = Math.ceil(l/16);
        var M = new Array(N);
        for (var i=0; i<N; i++) {
            M[i] = new Array(16);
            // encode 4 chars per integer, big-endian encoding
            for (var j=0; j<16; j++) {
                M[i][j] = (msg.charCodeAt(i*64+j*4)<<24) |
                    (msg.charCodeAt(i*64+j*4+1)<<16) |
                    (msg.charCodeAt(i*64+j*4+2)<<8) |
                    (msg.charCodeAt(i*64+j*4+3));
            }
        }
        // add length (in bits) into final pair of 32-bit integers
        // (big-endian) [5.1.1]
        // note: most significant word would be
        // ((len-1)*8 >>> 32, but since JS converts
        // bitwise-op args to 32 bits, we need to simulate
        // this by arithmetic operators
        M[N-1][14] = ((msg.length-1)*8) / Math.pow(2, 32);
        M[N-1][14] = Math.floor(M[N-1][14]);
        M[N-1][15] = ((msg.length-1)*8) & 0xffffffff;

        // set initial hash value [§5.3.1]
        var H0 = 0x67452301;
        var H1 = 0xefcdab89;
        var H2 = 0x98badcfe;
        var H3 = 0x10325476;
        var H4 = 0xc3d2e1f0;

        // HASH COMPUTATION [§6.1.2]

        var W = new Array(80); var a, b, c, d, e;
        for (var i=0; i<N; i++) {

            // 1 - prepare message schedule 'W'
            for (var t=0;  t<16; t++)
                W[t] = M[i][t];
            for (var t=16; t<80; t++)
                W[t] = ROTL(W[t-3] ^ W[t-8] ^ W[t-14] ^ W[t-16], 1);

            // 2 - initialise five working variables
            // a, b, c, d, e with previous hash value
            a = H0; b = H1; c = H2; d = H3; e = H4;

            // 3 - main loop
            for (var t=0; t<80; t++) {
                // seq for blocks of 'f' functions and 'K' constants
                var s = Math.floor(t/20);
                var T = (ROTL(a,5) + f(s,b,c,d) + e + K[s] + W[t])
                    & 0xffffffff;
                e = d;
                d = c;
                c = ROTL(b, 30);
                b = a;
                a = T;
            }

            // 4 - compute the new intermediate hash value

            // note 'addition modulo 2^32'
            H0 = (H0+a) & 0xffffffff;
            H1 = (H1+b) & 0xffffffff;
            H2 = (H2+c) & 0xffffffff;
            H3 = (H3+d) & 0xffffffff;
            H4 = (H4+e) & 0xffffffff;
        }

        return H0.toHexStr() + H1.toHexStr() + H2.toHexStr() +
            H3.toHexStr() + H4.toHexStr();
    }
};
if (!String.prototype.endsWith) {
  String.prototype.endsWith = function(searchString, position) {
      var subjectString = this.toString();
      if (position === undefined || position > subjectString.length) {
        position = subjectString.length;
      }
      position -= searchString.length;
      var lastIndex = subjectString.indexOf(searchString, position);
      return lastIndex !== -1 && lastIndex === position;
  };
}

if (!String.prototype.includes) {
  String.prototype.includes = function() {'use strict';
    return String.prototype.indexOf.apply(this, arguments) !== -1;
  };
}


